// runs on the physical windows host next to the dcs gameservers, the
// only place that can reach a dcs server's control port, which only
// accepts connections from 127.0.0.1 on its own machine
// see docs/Why.md#why-does-the-mission-agent-have-no-accounts

// express and the upload/proxy/archive libraries this agent needs
const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const util = require("node:util");
const { createProxyMiddleware } = require("http-proxy-middleware");
const tar = require("tar");
const archiver = require("archiver");

// wrap console.* into the same ndjson line shape as src/appLog.js
// see docs/Why.md#why-does-agentjs-duplicate-applogjss-log-format
function installConsoleCapture() {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  function emit(write, level, args) {
    const msg = args.map((a) => (typeof a === "string" ? a : util.inspect(a))).join(" ");
    write(JSON.stringify({ t: new Date().toISOString(), level, msg }));
  }
  console.log = (...args) => emit(original.log, "log", args);
  console.warn = (...args) => emit(original.warn, "warn", args);
  console.error = (...args) => emit(original.error, "error", args);
  // its own level, kept in sync with appLog.js's console.debug wrapper
  console.debug = (...args) => emit(original.debug, "debug", args);
}
installConsoleCapture();

const PORT = Number(process.env.AGENT_PORT || 4000);
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);
const SAVED_GAMES_ROOT = process.env.DCS_SAVED_GAMES_ROOT;
const DEFAULT_WEBGUI_PORT = 8088;

// process.execPath, through the "current" junction, resolves to
// whichever slot is actually running, install.ps1 pins this to
// installdir\agent.log explicitly, the same path nssm already writes to
const AGENT_LOG_FILE = process.env.AGENT_LOG_FILE || path.join(path.dirname(process.execPath), "agent.log");
const MAX_LOG_READ_LINES = 1000;

// resolve this agent's own bearer token, generating and persisting
// one on first start if none was given
// see docs/Why.md#why-does-the-agent-persist-its-own-generated-token
function resolveAgentToken() {
  if (process.env.MISSION_AGENT_TOKEN) return process.env.MISSION_AGENT_TOKEN;

  const tokenFile = process.env.MISSION_AGENT_TOKEN_FILE || path.join(path.dirname(process.execPath), "agent-token.txt");
  try {
    const existing = fsSync.readFileSync(tokenFile, "utf8").trim();
    if (existing) {
      console.log(`Loaded the existing MISSION_AGENT_TOKEN from ${tokenFile}.`);
      return existing;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const token = crypto.randomBytes(32).toString("hex");
  try {
    fsSync.writeFileSync(tokenFile, token, "utf8");
    console.log(`Generated a new MISSION_AGENT_TOKEN, saved to ${tokenFile}.`);
  } catch (err) {
    console.warn(
      `Generated a new MISSION_AGENT_TOKEN but could not save it to ${tokenFile}: ${err.message}. ` +
        `This token is in-memory only and will change on the next restart.`
    );
  }
  return token;
}

const AGENT_TOKEN = resolveAgentToken();

// nothing else here works without knowing where missions actually live
if (!SAVED_GAMES_ROOT) {
  console.error("DCS_SAVED_GAMES_ROOT is not set. Refusing to start.");
  process.exit(1);
}

// admin-typed dcs instance folder name under saved games, dots are
// normal in real instance names, only a string of dots alone is
// rejected, kept in sync with server.js's own copy of this pattern
const INSTANCE_NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

// turn an instance name into its real directory, or null if unsafe
function resolveInstanceDir(instanceName) {
  if (!INSTANCE_NAME_RE.test(instanceName || "")) return null;
  const dir = path.join(SAVED_GAMES_ROOT, instanceName);
  const resolvedRoot = path.resolve(SAVED_GAMES_ROOT);
  const resolvedDir = path.resolve(dir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) return null;
  return resolvedDir;
}

// the path autoexec.cfg lives at for a given instance directory
function autoexecPath(instanceDir) {
  return path.join(instanceDir, "Config", "autoexec.cfg");
}

// read today's webgui_port from autoexec.cfg, never guessing or writing
async function readWebguiPort(instanceDir) {
  let contents;
  try {
    contents = await fs.readFile(autoexecPath(instanceDir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { configExists: false, webguiPort: null };
    throw err;
  }
  // anchored per line, ignores a trailing lua comment, last match wins
  // see docs/Why.md#why-does-readwebguiport-anchor-its-regex-per-line
  const matches = [...contents.matchAll(/^\s*webgui_port\s*=\s*(\d+)\s*(?:--.*)?$/gim)];
  const last = matches.pop();
  return { configExists: true, webguiPort: last ? Number(last[1]) : null };
}

const app = express();
// drop the x-powered-by header, no need to advertise the framework
app.disable("x-powered-by");

// express middleware: require a valid bearer token on every request
function checkToken(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).send("Missing bearer token.");
  const expected = Buffer.from(AGENT_TOKEN);
  const got = Buffer.from(token);
  // constant time, a naive === leaks the token one byte at a time
  // through timing differences to anyone who can reach this port
  const match = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  if (!match) return res.status(401).send("Invalid bearer token.");
  next();
}

// express middleware: resolve :instanceName into req.instanceDir
function requireInstanceDir(req, res, next) {
  const dir = resolveInstanceDir(req.params.instanceName);
  if (!dir) return res.status(400).send("Invalid instance name.");
  req.instanceDir = dir;
  next();
}

// section: mission upload, list, download, soft-delete

// the Missions folder under one instance's own directory
function missionsDir(instanceDir) {
  return path.join(instanceDir, "Missions");
}

// turn admin-typed-adjacent input into a safe path inside targetDir
// shared by upload, download, and trash below
function safeMissionPath(targetDir, filename) {
  // strips any directory components first
  const safeName = path.basename(filename || "");
  const finalPath = path.join(targetDir, safeName);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedFinal = path.resolve(finalPath);
  if (resolvedFinal !== resolvedTarget && !resolvedFinal.startsWith(resolvedTarget + path.sep)) return null;
  return { safeName, finalPath };
}

// an RFC 6266 Content-Disposition value: a quoted ascii fallback for
// clients that don't decode filename*, plus the real name for ones that do
// see docs/Why.md#why-does-content-disposition-carry-two-filenames
function contentDispositionValue(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "\\$&");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// missions arrive in memory, then get written to disk atomically
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_BYTES, files: 1 },
});

app.post("/upload", checkToken, upload.single("mission"), async (req, res) => {
  const instanceName = req.body?.instance_name;
  const instanceDir = resolveInstanceDir(instanceName);
  if (!instanceDir) return res.status(400).send("Unknown or invalid instance_name.");
  if (!req.file) return res.status(400).send("No file provided.");
  if (!req.file.originalname.toLowerCase().endsWith(".miz")) {
    return res.status(400).send("Only .miz files are accepted.");
  }

  const targetDir = missionsDir(instanceDir);
  const resolved = safeMissionPath(targetDir, req.file.originalname);
  if (!resolved) return res.status(400).send("Invalid filename.");
  const { finalPath } = resolved;

  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(tmpPath, req.file.buffer);
    // atomic write, dcs never sees a partial file
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    return res.status(500).send(`Write failed: ${err.message}`);
  }

  res.json({ ok: true, path: finalPath });
});

app.get("/missions/:instanceName", checkToken, requireInstanceDir, async (req, res) => {
  const targetDir = missionsDir(req.instanceDir);
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.json({ missions: [] });
    return res.status(500).send(`Could not list missions: ${err.message}`);
  }

  const missions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".miz"))
      .map(async (entry) => {
        const stat = await fs.stat(path.join(targetDir, entry.name));
        return { name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
      })
  );
  res.json({ missions });
});

app.post("/missions/:instanceName/download", checkToken, requireInstanceDir, express.json(), async (req, res) => {
  const names = Array.isArray(req.body?.missions) ? req.body.missions : [];
  if (names.length === 0) return res.status(400).send("No missions named.");

  const targetDir = missionsDir(req.instanceDir);
  const resolvedPaths = [];
  for (const name of names) {
    const resolved = safeMissionPath(targetDir, name);
    if (!resolved) return res.status(400).send(`Invalid mission name: ${name}`);
    if (!fsSync.existsSync(resolved.finalPath)) return res.status(404).send(`Mission not found: ${resolved.safeName}`);
    resolvedPaths.push(resolved);
  }

  // one .miz is already a zip, renamed, so it needs no wrapping at all
  if (resolvedPaths.length === 1) {
    const { safeName, finalPath } = resolvedPaths[0];
    res.set("Content-Disposition", contentDispositionValue(safeName));
    res.set("Content-Type", "application/zip");
    return fsSync.createReadStream(finalPath).pipe(res);
  }

  // more than one gets bundled, unmodified, into one outer zip
  res.set("Content-Disposition", contentDispositionValue("missions.zip"));
  res.set("Content-Type", "application/zip");
  // already-compressed .miz files, re-compressing just burns cpu
  const archive = archiver("zip", { zlib: { level: 0 } });
  archive.on("error", (err) => {
    if (!res.headersSent) res.status(500);
    res.end(`Failed to build zip: ${err.message}`);
  });
  archive.pipe(res);
  for (const { safeName, finalPath } of resolvedPaths) {
    archive.file(finalPath, { name: safeName });
  }
  archive.finalize();
});

app.post("/missions/:instanceName/trash", checkToken, requireInstanceDir, express.json(), async (req, res) => {
  const names = Array.isArray(req.body?.missions) ? req.body.missions : [];
  if (names.length === 0) return res.status(400).send("No missions named.");

  const targetDir = missionsDir(req.instanceDir);
  const resolvedPaths = [];
  for (const name of names) {
    const resolved = safeMissionPath(targetDir, name);
    if (!resolved) return res.status(400).send(`Invalid mission name: ${name}`);
    if (!fsSync.existsSync(resolved.finalPath)) return res.status(404).send(`Mission not found: ${resolved.safeName}`);
    resolvedPaths.push(resolved);
  }

  // move aside, never unlink, see docs/Why.md#why-does-the-mission-agent-have-no-accounts
  const trashDir = path.join(targetDir, ".trash");
  await fs.mkdir(trashDir, { recursive: true });
  try {
    for (const { safeName, finalPath } of resolvedPaths) {
      await fs.rename(finalPath, path.join(trashDir, `${safeName}.${Date.now()}`));
    }
  } catch (err) {
    return res.status(500).send(`Could not move to trash: ${err.message}`);
  }
  res.json({ ok: true });
});

// section: webgui control port, status, config write, relay

app.get("/webgui/:instanceName/status", checkToken, requireInstanceDir, async (req, res) => {
  const status = await readWebguiPort(req.instanceDir);
  res.json(status);
});

app.post("/webgui/:instanceName/ensure-port", checkToken, requireInstanceDir, express.json(), async (req, res) => {
  const port = Number(req.body?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return res.status(400).json({ error: "port must be an integer in 1..65535" });
  }

  const current = await readWebguiPort(req.instanceDir);
  if (current.webguiPort !== null) {
    // defensive no-op, never silently overwrite a value already there
    return res.json({ ok: true, webguiPort: current.webguiPort, created: false });
  }

  const cfgPath = autoexecPath(req.instanceDir);
  const line = `webgui_port = ${port}`;
  if (current.configExists) {
    // append, never rewrite, other key=value pairs must survive
    await fs.appendFile(cfgPath, `\n${line}\n`, "utf8");
  } else {
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, `${line}\n`, "utf8");
  }
  res.json({ ok: true, webguiPort: port, created: true });
});

// the actual control-port proxy, routed per instance from above
const webguiProxyMiddleware = createProxyMiddleware({
  router: async (req) => {
    const { webguiPort } = await readWebguiPort(req.instanceDir);
    return `http://127.0.0.1:${webguiPort ?? DEFAULT_WEBGUI_PORT}`;
  },
  pathRewrite: (reqPath, req) => {
    const prefix = `/webgui/${req.params.instanceName}`;
    const rest = reqPath.startsWith(prefix) ? reqPath.slice(prefix.length) : reqPath;
    return rest || "/";
  },
  changeOrigin: true,
  on: {
    proxyReq(proxyReq) {
      // the bearer token checkToken already verified must not ride any
      // further than this agent, same for the browser's own cookie/origin
      proxyReq.removeHeader("authorization");
      proxyReq.removeHeader("cookie");
      proxyReq.removeHeader("origin");
    },
    error(err, req, res) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Could not reach the DCS server: ${err.message}`);
    },
  },
});

app.use("/webgui/:instanceName", checkToken, requireInstanceDir, webguiProxyMiddleware);

// section: dcs install webgui bundle
// lets the auth-gate pull the real webgui spa straight out of a dcs
// world server install already on this host, instead of an admin
// copying it into webgui-static/ by hand
// see docs/Why.md#why-isnt-the-dcs-install-path-confined-to-a-fixed-root

app.get("/dcs-install/webgui-bundle", checkToken, async (req, res) => {
  const installPath = req.query.path;
  if (!installPath || typeof installPath !== "string") {
    return res.status(400).send("Missing path query parameter.");
  }

  const webguiDir = path.join(installPath, "WebGUI");
  try {
    await fs.access(path.join(webguiDir, "index.html"));
  } catch {
    return res.status(404).send(`No WebGUI folder found at ${webguiDir} (index.html missing).`);
  }

  res.set("Content-Type", "application/x-tar");
  const stream = tar.c({ cwd: webguiDir }, ["."]);
  stream.on("error", (err) => {
    if (!res.headersSent) res.status(500);
    res.end(`Failed to read webgui bundle: ${err.message}`);
  });
  stream.pipe(res);
});

// section: self-update, stage and commit
// relayed through the auth-gate (see src/updateCheck.js) since this
// host has no internet access of its own by design
// see docs/Why.md#why-does-the-agent-use-a-current-junction

// overrides the root for local dev/tests, where process.execPath
// points at node itself, not a packaged agent.exe next to a real
// "current" junction
const SELF_UPDATE_ROOT = process.env.AGENT_SELF_UPDATE_ROOT || path.dirname(path.dirname(process.execPath));
const CURRENT_LINK = path.join(SELF_UPDATE_ROOT, "current");
const RELEASES_DIR = path.join(SELF_UPDATE_ROOT, "releases");

// read which slot ("a" or "b") the current junction points at
function readActiveAgentSlot() {
  try {
    return path.basename(fsSync.readlinkSync(CURRENT_LINK)) === "b" ? "b" : "a";
  } catch (err) {
    return "a";
  }
}

// return whichever slot isn't the one passed in
function otherAgentSlot(slot) {
  return slot === "a" ? "b" : "a";
}

// the staged build arrives as a raw binary body, not multipart
const selfUpdateUpload = express.raw({ type: "application/octet-stream", limit: MAX_MISSION_BYTES });

app.post("/self-update/stage", checkToken, selfUpdateUpload, async (req, res) => {
  const expectedSha256 = req.get("X-Sha256");
  if (!expectedSha256) return res.status(400).send("Missing X-Sha256 header.");
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).send("No file body received.");

  // re-hash independently, catches corruption on this specific hop,
  // on top of the signature check already done on the auth-gate side
  const actualSha256 = crypto.createHash("sha256").update(req.body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    return res.status(400).send(`sha256 mismatch (expected ${expectedSha256}, got ${actualSha256}).`);
  }

  const idleSlot = otherAgentSlot(readActiveAgentSlot());
  const slotDir = path.join(RELEASES_DIR, idleSlot);
  await fs.mkdir(slotDir, { recursive: true });
  const finalPath = path.join(slotDir, "agent.exe");
  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmpPath, req.body);
    // atomic write, same reasoning as the mission upload above
    await fs.rename(tmpPath, finalPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    return res.status(500).send(`Could not stage update: ${err.message}`);
  }
  res.json({ ok: true, slot: idleSlot });
});

app.post("/self-update/commit", checkToken, async (req, res) => {
  const idleSlot = otherAgentSlot(readActiveAgentSlot());
  const idleSlotDir = path.join(RELEASES_DIR, idleSlot);
  if (!fsSync.existsSync(path.join(idleSlotDir, "agent.exe"))) {
    return res.status(400).send(`No staged build in slot ${idleSlot}. Stage one first.`);
  }

  try {
    await fs.rm(CURRENT_LINK, { force: true });
    await fs.symlink(idleSlotDir, CURRENT_LINK, "junction");
  } catch (err) {
    return res.status(500).send(`Could not flip to the new build: ${err.message}`);
  }

  // deliberate restart, not a crash, see docs/Why.md#why-does-the-agent-use-a-current-junction
  // skip-exit exists only so a test's http round trip survives it
  if (!process.env.AGENT_SELF_UPDATE_SKIP_EXIT) res.on("finish", () => process.exit(1));
  res.json({ ok: true, activeSlot: idleSlot });
});

// section: logs, a tail of this agent's own log file
// nssm's own appstdout/appstderr redirection (install.ps1) is what
// actually writes and rotates agent_log_file, this just reads it back

app.get("/logs", checkToken, async (req, res) => {
  let raw;
  try {
    raw = await fs.readFile(AGENT_LOG_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return res.type("text/plain").send("");
    return res.status(500).send(`Could not read ${AGENT_LOG_FILE}: ${err.message}`);
  }
  const lines = raw.split("\n").filter(Boolean).slice(-MAX_LOG_READ_LINES);
  res.type("text/plain").send(lines.join("\n"));
});

// anything not matched above is a plain 404
app.use((req, res) => res.status(404).send("Not found."));

// only listen when run directly, tests import the app instead
// see docs/Why.md#why-doesnt-the-control-port-proxy-handle-websocket-upgrades
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`mission-agent listening on :${PORT}`);
  });
}

// expose the express app itself, for both real use and tests
module.exports = app;
