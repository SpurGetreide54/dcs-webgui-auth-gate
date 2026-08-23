// Runs on the physical Windows host, next to the DCS gameservers. This is
// the only place that can reach a DCS server's control port -- that port
// only accepts connections from 127.0.0.1 on its own machine.
//
// Deliberately small: a write-only mission-upload endpoint, a webgui
// control-port relay, and a shared-token check. No accounts. No login. No
// read/list/delete of the mission folders it's given.
//
// Deploy on Windows as a service, e.g. via NSSM or node-windows. This host
// has no existing Node process supervisor. See scripts/build-agent-exe.sh
// to package this as a standalone .exe -- the host then needs no Node.js
// install.

const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const { createProxyMiddleware } = require("http-proxy-middleware");
const tar = require("tar");

const PORT = Number(process.env.AGENT_PORT || 4000);
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);
const SAVED_GAMES_ROOT = process.env.DCS_SAVED_GAMES_ROOT;
const DEFAULT_WEBGUI_PORT = 8088;

// MISSION_AGENT_TOKEN authenticates the auth-gate to this agent. An
// explicit env value always wins. Otherwise this agent is the source of
// truth: it generates one on first start and persists it next to itself,
// so a deployer never has to invent a value by hand for a headless
// service with no interactive prompt. The value itself is never logged --
// only which of these two cases happened -- since agent.log is easy to
// end up pasted into a chat or a screen share. process.execPath, not
// __dirname, is what resolves to a real on-disk path inside the packaged
// SEA agent.exe.
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

if (!SAVED_GAMES_ROOT) {
  console.error("DCS_SAVED_GAMES_ROOT is not set. Refusing to start.");
  process.exit(1);
}

// Auth-gate admins pick this per server -- the DCS instance folder name
// under Saved Games, e.g. "Example_Training", or the DCS default
// "DCS.dcs_serverrelease". This is admin-typed input flowing straight into
// filesystem paths, so it gets the same path-traversal guard as the upload
// filename handling below. Dots are normal in real instance names. Only a
// string of dots alone (".", "..") is rejected. Kept in sync with
// server.js's copy of this pattern.
const INSTANCE_NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

function resolveInstanceDir(instanceName) {
  if (!INSTANCE_NAME_RE.test(instanceName || "")) return null;
  const dir = path.join(SAVED_GAMES_ROOT, instanceName);
  const resolvedRoot = path.resolve(SAVED_GAMES_ROOT);
  const resolvedDir = path.resolve(dir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) return null;
  return resolvedDir;
}

function autoexecPath(instanceDir) {
  return path.join(instanceDir, "Config", "autoexec.cfg");
}

// Never guesses or writes. Reports only what's in the file today.
async function readWebguiPort(instanceDir) {
  let contents;
  try {
    contents = await fs.readFile(autoexecPath(instanceDir), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { configExists: false, webguiPort: null };
    throw err;
  }
  const match = contents.match(/webgui_port\W*=\W*(\d+)/i);
  return { configExists: true, webguiPort: match ? Number(match[1]) : null };
}

const app = express();
app.disable("x-powered-by");

function checkToken(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return res.status(401).send("Missing bearer token.");
  const expected = Buffer.from(AGENT_TOKEN);
  const got = Buffer.from(token);
  // Constant-time comparison. A naive === leaks the token one byte at a
  // time through timing differences, to anyone who can reach this port.
  const match = expected.length === got.length && crypto.timingSafeEqual(expected, got);
  if (!match) return res.status(401).send("Invalid bearer token.");
  next();
}

function requireInstanceDir(req, res, next) {
  const dir = resolveInstanceDir(req.params.instanceName);
  if (!dir) return res.status(400).send("Invalid instance name.");
  req.instanceDir = dir;
  next();
}

// ---- mission upload ----

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_BYTES, files: 1 },
});

app.post("/upload", checkToken, upload.single("mission"), async (req, res) => {
  const instanceName = req.body?.instance_name;
  const instanceDir = resolveInstanceDir(instanceName);
  if (!instanceDir) return res.status(400).send("Unknown or invalid instance_name.");
  if (!req.file) return res.status(400).send("No file provided.");

  // path.basename strips any directory components. The extension check and
  // the resolve()-inside-targetDir check below are what actually stop a
  // crafted filename, e.g. "../../autoexec.cfg", from writing outside the
  // mission folder.
  const safeName = path.basename(req.file.originalname);
  if (!safeName.toLowerCase().endsWith(".miz")) {
    return res.status(400).send("Only .miz files are accepted.");
  }

  const targetDir = path.join(instanceDir, "Missions");
  const finalPath = path.join(targetDir, safeName);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedFinal = path.resolve(finalPath);
  if (resolvedFinal !== resolvedTarget && !resolvedFinal.startsWith(resolvedTarget + path.sep)) {
    return res.status(400).send("Invalid filename.");
  }

  const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(tmpPath, req.file.buffer);
    await fs.rename(tmpPath, finalPath); // Atomic write: DCS never sees a partial file.
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    return res.status(500).send(`Write failed: ${err.message}`);
  }

  res.json({ ok: true, path: finalPath });
});

// ---- webgui control port: status, config write, relay ----

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
    // Defensive no-op. The confirm flow on the auth-gate side should only
    // call this for instances /status reported as missing a port. Never
    // silently overwrite a value that's already there.
    return res.json({ ok: true, webguiPort: current.webguiPort, created: false });
  }

  const cfgPath = autoexecPath(req.instanceDir);
  const line = `webgui_port = ${port}`;
  if (current.configExists) {
    // Append, never rewrite. autoexec.cfg is a normal editable config file
    // and can already carry other key=value pairs. Those must survive.
    await fs.appendFile(cfgPath, `\n${line}\n`, "utf8");
  } else {
    await fs.mkdir(path.dirname(cfgPath), { recursive: true });
    await fs.writeFile(cfgPath, `${line}\n`, "utf8");
  }
  res.json({ ok: true, webguiPort: port, created: true });
});

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
  ws: true,
  on: {
    error(err, req, res) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(`Could not reach the DCS server: ${err.message}`);
    },
  },
});

app.use("/webgui/:instanceName", checkToken, requireInstanceDir, webguiProxyMiddleware);

// ---- dcs install webgui bundle ----
// Lets the auth-gate pull the real webgui SPA straight out of a DCS World
// Server install already on this host, instead of an admin copying it into
// webgui-static/ by hand. The install root is arbitrary admin-typed input.
// Unlike instanceName, it isn't confined under a fixed root -- same trust
// level an account-manager admin already has via instance_name/mission
// uploads, not a new privilege boundary.

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

app.use((req, res) => res.status(404).send("Not found."));

if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    console.log(`mission-agent listening on :${PORT}`);
  });
  httpServer.on("upgrade", webguiProxyMiddleware.upgrade);
}

module.exports = app;
