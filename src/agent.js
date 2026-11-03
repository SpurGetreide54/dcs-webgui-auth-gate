// runs on the physical windows host next to the dcs gameservers, the
// only place that can reach a dcs server's control port (127.0.0.1-only)
// see docs/Deployment-Topology.md

// express and the upload/proxy/archive libraries this agent needs
const express = require("express");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const util = require("node:util");
const { createProxyMiddleware } = require("http-proxy-middleware");
const tar = require("tar");
const archiver = require("archiver");
const { isVersionGreater } = require("./versionCompare");
const { INSTANCE_NAME_RE, asyncHandler, errorHandler, logFatalAndExit } = require("./common");
const { otherSlot } = require("./activeSlot");

// __AGENT_VERSION__ is baked in at build time by build-agent-exe.sh's
// esbuild --define; unbundled (tests, local dev under node) falls
// through to reading package.json live
const AGENT_VERSION = typeof __AGENT_VERSION__ !== "undefined" ? __AGENT_VERSION__ : require("../package.json").version;

// wrap console.* into the same ndjson line shape as src/appLog.js
// see docs/Why.md#why-does-agentjs-duplicate-applogjss-log-format-instead-of-importing-it
function installConsoleCapture() {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  // write one captured console call as an ndjson line
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

// process.execPath, through the "current" junction, resolves to
// whichever slot is actually running, install.ps1 pins this to
// installdir\agent.log explicitly, the same path nssm already writes to
const AGENT_LOG_FILE = process.env.AGENT_LOG_FILE || path.join(path.dirname(process.execPath), "agent.log");
const MAX_LOG_READ_LINES = 1000;

// resolve this agent's own bearer token, generating and persisting
// one on first start if none was given
// see docs/Why.md#why-does-the-agent-persist-its-own-generated-token-instead-of-requiring-one-upfront
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

// turn an instance name into its real directory, or null if unsafe
function resolveInstanceDir(instanceName) {
  // a non-string would coerce through the regex test below, then
  // throw inside path.join
  // see docs/Why.md#why-does-the-agent-check-typeof-before-every-path-operation
  if (typeof instanceName !== "string") return null;
  if (!INSTANCE_NAME_RE.test(instanceName)) return null;
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

// section: connectivity check, for the auth-gate's diagnostics page

app.get("/ping", checkToken, (req, res) => {
  res.json({ ok: true });
});

// section: mission upload, list, download, soft-delete

// the Missions folder under one instance's own directory
function missionsDir(instanceDir) {
  return path.join(instanceDir, "Missions");
}

// turn admin-typed-adjacent input into a safe path inside targetDir
// shared by upload, download, and trash below
function safeMissionPath(targetDir, filename, { requireMiz = false } = {}) {
  // a non-string entry would otherwise throw inside path.basename below
  // see docs/Why.md#why-does-the-agent-check-typeof-before-every-path-operation
  if (typeof filename !== "string") return null;
  // strips any directory components first
  const safeName = path.basename(filename);
  // an empty or dot-led name resolves to targetDir itself (or a
  // hidden entry such as .trash), never a real mission
  // see docs/Why.md#why-does-safemissionpath-reject-empty-and-dot-led-names
  if (!safeName || safeName.startsWith(".")) return null;
  // callers resolving a trash entry's own on-disk name (ending in
  // .<timestamp>, not .miz) leave this off, see
  // docs/Why.md#why-do-download-trash-and-restore-require-miz-like-upload-already-did
  if (requireMiz && !safeName.toLowerCase().endsWith(".miz")) return null;
  const finalPath = path.join(targetDir, safeName);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedFinal = path.resolve(finalPath);
  if (!resolvedFinal.startsWith(resolvedTarget + path.sep)) return null;
  return { safeName, finalPath };
}

// true only for an existing plain file, never a directory
async function isExistingFile(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

// claims the first unused "<name>(n).ext" for a colliding upload by
// hard-linking the tmp file into place, so two uploads racing for the
// same name can never overwrite each other, see docs/Why.md#why-does-the-upload-claim-its-final-name-with-fslink-instead-of-checking-then-renaming
async function claimMissionName(targetDir, tmpPath, safeName) {
  const ext = path.extname(safeName);
  const base = safeName.slice(0, -ext.length);
  let candidate = safeName;
  for (let n = 1; ; n++) {
    const finalPath = path.join(targetDir, candidate);
    try {
      await fs.link(tmpPath, finalPath);
      return { safeName: candidate, finalPath };
    } catch (err) {
      // branch: someone else just claimed this exact name, try the next one
      if (err.code !== "EEXIST") throw err;
      candidate = `${base}(${n})${ext}`;
    }
  }
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
  // multer's own default reads multipart filenames as latin1, which
  // mangles anything non-ASCII, see
  // docs/Why.md#why-does-multer-need-defparamcharset-utf8
  defParamCharset: "utf8",
});

app.post("/upload", checkToken, upload.single("mission"), asyncHandler(async (req, res) => {
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

  await fs.mkdir(targetDir, { recursive: true });

  const tmpPath = path.join(targetDir, `.${crypto.randomBytes(6).toString("hex")}.tmp`);
  let claimed;
  try {
    await fs.writeFile(tmpPath, req.file.buffer);
    // a same-name collision is saved alongside the existing mission
    // under a (1), (2), ... suffix, never overwriting it, even against
    // a second upload racing for the same name
    claimed = await claimMissionName(targetDir, tmpPath, resolved.safeName);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    return res.status(500).send(`Write failed: ${err.message}`);
  }
  await fs.rm(tmpPath, { force: true });

  res.json({ ok: true, path: claimed.finalPath, safeName: claimed.safeName });
}));

app.get("/missions/:instanceName", checkToken, requireInstanceDir, asyncHandler(async (req, res) => {
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
}));

app.post("/missions/:instanceName/download", checkToken, requireInstanceDir, express.json(), asyncHandler(async (req, res) => {
  const names = Array.isArray(req.body?.missions) ? req.body.missions : [];
  if (names.length === 0) return res.status(400).send("No missions named.");

  const targetDir = missionsDir(req.instanceDir);
  const resolvedPaths = [];
  for (const name of names) {
    const resolved = safeMissionPath(targetDir, name, { requireMiz: true });
    if (!resolved) return res.status(400).send(`Invalid mission name: ${name}`);
    if (!(await isExistingFile(resolved.finalPath))) return res.status(404).send(`Mission not found: ${resolved.safeName}`);
    resolvedPaths.push(resolved);
  }

  // one .miz is already a zip, renamed, so it needs no wrapping at all
  if (resolvedPaths.length === 1) {
    const { safeName, finalPath } = resolvedPaths[0];
    // open before setting any header: a file removed or replaced by
    // something unreadable after the isExistingFile check above gets
    // a real 500 body instead of a reset connection
    // see docs/Why.md#why-does-the-download-handler-remove-its-own-content-type-header-on-failure
    let fd;
    try {
      fd = fsSync.openSync(finalPath, "r");
    } catch (err) {
      return res.status(500).send(`Failed to read mission: ${err.message}`);
    }
    res.set("Content-Disposition", contentDispositionValue(safeName));
    res.set("Content-Type", "application/zip");
    const stream = fsSync.createReadStream(finalPath, { fd });
    // the open above already ruled out the likely failure; anything
    // past this point can only reset the connection, not reply
    return pipeline(stream, res).catch((err) => res.destroy(err));
  }

  // more than one gets bundled, unmodified, into one outer zip
  res.set("Content-Disposition", contentDispositionValue("missions.zip"));
  res.set("Content-Type", "application/zip");
  // already-compressed .miz files, re-compressing just burns cpu
  const archive = archiver("zip", { zlib: { level: 0 } });
  // starts before finalize(), since archiver buffers internally until
  // finalize() signals end; archiver reads each file lazily from
  // there, after headers are already streamed, so a failure can only reset
  const done = pipeline(archive, res).catch((err) => res.destroy(err));
  for (const { safeName, finalPath } of resolvedPaths) {
    archive.file(finalPath, { name: safeName });
  }
  archive.finalize();
  await done;
}));

app.post("/missions/:instanceName/trash", checkToken, requireInstanceDir, express.json(), asyncHandler(async (req, res) => {
  // a repeated name is a no-op, not a second, failing rename
  const names = [...new Set(Array.isArray(req.body?.missions) ? req.body.missions : [])];
  if (names.length === 0) return res.status(400).send("No missions named.");

  const targetDir = missionsDir(req.instanceDir);
  const resolvedPaths = [];
  for (const name of names) {
    const resolved = safeMissionPath(targetDir, name, { requireMiz: true });
    if (!resolved) return res.status(400).send(`Invalid mission name: ${name}`);
    if (!(await isExistingFile(resolved.finalPath))) return res.status(404).send(`Mission not found: ${resolved.safeName}`);
    resolvedPaths.push(resolved);
  }

  // move aside, never unlink, see docs/Why.md#why-does-the-mission-agent-have-no-accounts-just-a-shared-bearer-token
  const trashDir = path.join(targetDir, ".trash");
  await fs.mkdir(trashDir, { recursive: true });
  try {
    for (const { safeName, finalPath } of resolvedPaths) {
      // bump the millisecond suffix on a same-millisecond collision,
      // rather than let fs.rename silently replace the earlier entry
      let ts = Date.now();
      let target = path.join(trashDir, `${safeName}.${ts}`);
      while (await isExistingFile(target)) {
        ts++;
        target = path.join(trashDir, `${safeName}.${ts}`);
      }
      await fs.rename(finalPath, target);
    }
  } catch (err) {
    return res.status(500).send(`Could not move to trash: ${err.message}`);
  }
  res.json({ ok: true });
}));

// a trashed file's on-disk name is "<original name>.<Date.now()>", see
// the trash route above, this splits it back into both parts
function parseTrashEntryName(entryName) {
  const match = entryName.match(/^(.+)\.(\d+)$/);
  if (!match) return null;
  const trashedAt = new Date(Number(match[2]));
  // a digit run beyond the Date range (a hand-placed entry), treated
  // the same as a name that doesn't match the regex at all
  if (Number.isNaN(trashedAt.getTime())) return null;
  return { name: match[1], trashedAt: trashedAt.toISOString() };
}

app.get("/missions/:instanceName/trash", checkToken, requireInstanceDir, asyncHandler(async (req, res) => {
  const trashDir = path.join(missionsDir(req.instanceDir), ".trash");
  let entries;
  try {
    entries = await fs.readdir(trashDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return res.json({ trash: [] });
    return res.status(500).send(`Could not list trash: ${err.message}`);
  }

  const trash = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const parsed = parseTrashEntryName(entry.name);
        // an entry that doesn't parse predates this format or was
        // placed there by hand, list only what this feature itself trashed
        if (!parsed) return null;
        const stat = await fs.stat(path.join(trashDir, entry.name));
        return { trashName: entry.name, name: parsed.name, size: stat.size, trashedAt: parsed.trashedAt };
      })
  );
  res.json({ trash: trash.filter(Boolean) });
}));

app.post(
  "/missions/:instanceName/trash/restore",
  checkToken,
  requireInstanceDir,
  express.json(),
  asyncHandler(async (req, res) => {
    const trashNames = Array.isArray(req.body?.trash) ? req.body.trash : [];
    if (trashNames.length === 0) return res.status(400).send("No trash entries named.");

    const targetDir = missionsDir(req.instanceDir);
    const trashDir = path.join(targetDir, ".trash");
    // same reasoning as safeMissionPath itself: reject every bad name
    // before moving any file, so a bad name can't leave a half-applied batch
    const seenDestinations = new Set();
    const toRestore = [];
    for (const trashName of trashNames) {
      const resolved = safeMissionPath(trashDir, trashName);
      if (!resolved) return res.status(400).send(`Invalid trash entry: ${trashName}`);
      if (!(await isExistingFile(resolved.finalPath))) return res.status(404).send(`Trash entry not found: ${resolved.safeName}`);
      const parsed = parseTrashEntryName(resolved.safeName);
      if (!parsed) return res.status(400).send(`Unrecognized trash entry: ${resolved.safeName}`);
      // a trash entry whose original name wasn't .miz is exactly as
      // unsupported, from the restorer's point of view, as one that
      // doesn't parse at all
      if (!parsed.name.toLowerCase().endsWith(".miz")) return res.status(400).send(`Unrecognized trash entry: ${resolved.safeName}`);
      // on disk already, or claimed earlier in this same batch, either
      // way a silent fs.rename below would overwrite it
      const destination = path.join(targetDir, parsed.name);
      if (seenDestinations.has(destination) || (await isExistingFile(destination))) {
        return res.status(409).send(`A mission named "${parsed.name}" already exists, remove it first.`);
      }
      seenDestinations.add(destination);
      toRestore.push({ from: resolved.finalPath, to: destination, name: parsed.name });
    }

    try {
      for (const { from, to } of toRestore) {
        await fs.rename(from, to);
      }
    } catch (err) {
      return res.status(500).send(`Could not restore from trash: ${err.message}`);
    }
    res.json({ ok: true, restored: toRestore.map((r) => r.name) });
  })
);

// section: webgui control port, status, config write, relay

// kept entirely outside the /webgui/:instanceName/* namespace below,
// since that prefix's own pathRewrite forwards arbitrary
// client-supplied sub-paths into the proxy, see docs/Why.md#why-do-the-agents-own-status-and-ensure-port-routes-live-under-admin
app.get("/admin/webgui/:instanceName/status", checkToken, requireInstanceDir, asyncHandler(async (req, res) => {
  const status = await readWebguiPort(req.instanceDir);
  res.json(status);
}));

app.post("/admin/webgui/:instanceName/ensure-port", checkToken, requireInstanceDir, express.json(), asyncHandler(async (req, res) => {
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
}));

// express middleware: 502s an instance with no webgui_port set,
// instead of falling back to a port that may belong to another
// instance, see docs/Why.md#why-doesnt-the-webgui-proxy-fall-back-to-a-default-port
async function requireWebguiPort(req, res, next) {
  const { webguiPort } = await readWebguiPort(req.instanceDir);
  if (webguiPort === null) {
    return res.status(502).send("No webgui_port set for this instance. Assign one from /admin/servers/webgui-ports.");
  }
  req.webguiPort = webguiPort;
  next();
}

// the actual control-port proxy, routed per instance from above,
// since requireWebguiPort already guarantees req.webguiPort is set,
// so this never re-reads autoexec.cfg itself
const webguiProxyMiddleware = createProxyMiddleware({
  router: (req) => `http://127.0.0.1:${req.webguiPort}`,
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

app.use("/webgui/:instanceName", checkToken, requireInstanceDir, asyncHandler(requireWebguiPort), webguiProxyMiddleware);

// section: dcs install webgui bundle

// lets admins pull the webgui straight out of a dcs install on this host
// see docs/Why.md#why-isnt-the-dcs-install-path-confined-to-a-fixed-root

app.get("/dcs-install/webgui-bundle", checkToken, asyncHandler(async (req, res) => {
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
  // tar streams the whole directory as it reads it, after headers
  // are already streamed, so a failure here can only reset, not reply
  await pipeline(stream, res).catch((err) => res.destroy(err));
}));

// section: self-update, stage and commit

// relayed through the auth-gate since this host has no internet access
// see docs/Why.md#why-does-the-auth-gate-relay-the-agents-update

// keyRotationConstants.js and keyRotationVerify.js are both
// side-effect-free, unlike keyRotation.js itself, which pulls in
// db.js's native sqlite, wrong for this standalone exe, see
// docs/Why.md#why-does-the-agent-verify-the-staged-builds-signature-itself
const { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM, INITIAL_KEY_ROTATED_AT } = require("./keyRotationConstants");
const { verifyKeyState } = require("./keyRotationVerify");

// pinned by install.ps1 next to agent-token.txt, same as
// resolveAgentToken's own token file, above
const AGENT_KEY_STATE_FILE = process.env.AGENT_KEY_STATE_FILE || path.join(path.dirname(process.execPath), "agent-key-state.json");

// write the trust state via a tmp file plus rename, so a crash or a
// concurrent read never sees a truncated file
function saveKeyState(state) {
  const tmpPath = `${AGENT_KEY_STATE_FILE}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fsSync.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
  fsSync.renameSync(tmpPath, AGENT_KEY_STATE_FILE);
}

// a pre-pin install migrating forward: copy a legacy slot-relative
// state file into the newly pinned path, once, if one exists there
// see docs/Why.md#why-does-the-agent-migrate-a-legacy-key-state-file
function migrateLegacyKeyStateFile() {
  if (!process.env.AGENT_KEY_STATE_FILE) return;
  if (fsSync.existsSync(AGENT_KEY_STATE_FILE)) return;
  const legacyPath = process.env.AGENT_KEY_STATE_FILE_LEGACY_PATH_OVERRIDE || path.join(path.dirname(process.execPath), "agent-key-state.json");
  try {
    fsSync.copyFileSync(legacyPath, AGENT_KEY_STATE_FILE);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

// read the persisted trust state, seeding it from the built-in keys
// on first run or if the file is missing/corrupt
function loadOrSeedKeyState() {
  migrateLegacyKeyStateFile();
  try {
    return JSON.parse(fsSync.readFileSync(AGENT_KEY_STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`Could not read ${AGENT_KEY_STATE_FILE} (${err.message}), reseeding from the built-in keys.`);
    }
  }
  const seeded = {
    primary_public_key_pem: PRIMARY_PUBLIC_KEY_PEM,
    primary_rotated_at: INITIAL_KEY_ROTATED_AT,
    secondary_public_key_pem: SECONDARY_PUBLIC_KEY_PEM,
    secondary_rotated_at: INITIAL_KEY_ROTATED_AT,
  };
  saveKeyState(seeded);
  return seeded;
}

// loaded once at startup, same pattern as AGENT_TOKEN above, mutated
// in place and persisted whenever a relayed rotation record verifies
let agentKeyState = loadOrSeedKeyState();

// replay the gate-relayed rotation history into the trust state,
// same skip-older-than-trusted logic keyRotation.js's own checkKeyState
// has, applying (and persisting) each record that verifies
function applyKeyStateHistory(history) {
  for (const record of history) {
    const currentRotatedAt = agentKeyState[`${record.rotated_slot}_rotated_at`];
    // skip: already applied or older than what's trusted
    if (new Date(record.rotated_at).getTime() <= new Date(currentRotatedAt).getTime()) continue;
    if (verifyKeyState(record, agentKeyState)) {
      agentKeyState[`${record.rotated_slot}_public_key_pem`] = record.new_public_key_pem;
      agentKeyState[`${record.rotated_slot}_rotated_at`] = record.rotated_at;
      saveKeyState(agentKeyState);
    }
  }
}

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

// a separate route rather than a header on /self-update/stage: the
// full rotation history is unbounded and would eventually outgrow
// node's default header-size limit
// see docs/Why.md#why-does-relayagentupdate-post-the-key-state-history-instead-of-heading-it
app.post("/self-update/key-state", checkToken, express.json({ limit: "1mb" }), asyncHandler(async (req, res) => {
  const { history } = req.body;
  if (!Array.isArray(history)) return res.status(400).send("Malformed history in request body.");
  applyKeyStateHistory(history);
  res.json({ ok: true });
}));

// the staged build arrives as a raw binary body, not multipart
const selfUpdateUpload = express.raw({ type: "application/octet-stream", limit: MAX_MISSION_BYTES });

app.post("/self-update/stage", checkToken, selfUpdateUpload, asyncHandler(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).send("No file body received.");

  const signedHeader = req.get("X-Manifest-Signed");
  const signature = req.get("X-Manifest-Signature");
  if (!signedHeader || !signature) return res.status(400).send("Missing X-Manifest-Signed/X-Manifest-Signature header.");
  let signed;
  try {
    signed = JSON.parse(signedHeader);
  } catch {
    return res.status(400).send("Malformed X-Manifest-Signed header.");
  }

  // verify against the (possibly just-rotated) trusted primary key,
  // never secondary, same rule as updateCheck.js's own verifyManifest
  const message = Buffer.from(JSON.stringify(signed));
  let manifestOk;
  try {
    const trustedKey = crypto.createPublicKey(agentKeyState.primary_public_key_pem);
    manifestOk = crypto.verify(null, message, trustedKey, Buffer.from(signature, "hex"));
  } catch {
    manifestOk = false;
  }
  if (!manifestOk) return res.status(400).send("Manifest signature verification failed.");

  const agentEntry = (signed.downloads || []).find((d) => d.artifact === "agent");
  if (!agentEntry) return res.status(400).send('Manifest has no download entry for "agent".');

  // hashes the received bytes against the signed manifest's own claim,
  // not a caller-supplied header, which is what actually authenticates
  // the upload, see docs/Why.md#why-does-the-agent-verify-the-staged-builds-signature-itself
  const actualSha256 = crypto.createHash("sha256").update(req.body).digest("hex");
  if (actualSha256 !== agentEntry.sha256) {
    return res.status(400).send(`sha256 mismatch (expected ${agentEntry.sha256}, got ${actualSha256}).`);
  }

  // the gate's own downgrade guard protects only callers that go
  // through it; a validly signed old manifest must still be rejected
  // here, with 409 (not 400) marking it a stale conflict, not a mistake
  // see docs/Why.md#why-does-the-agent-also-check-the-offered-version-at-self-updatestage
  if (!isVersionGreater(signed.version, AGENT_VERSION)) {
    return res.status(409).send(`Offered version ${signed.version} is not newer than the current ${AGENT_VERSION}, refusing to stage.`);
  }

  const idleSlot = otherSlot(readActiveAgentSlot());
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
}));

app.post("/self-update/commit", checkToken, asyncHandler(async (req, res) => {
  const idleSlot = otherSlot(readActiveAgentSlot());
  const idleSlotDir = path.join(RELEASES_DIR, idleSlot);
  if (!fsSync.existsSync(path.join(idleSlotDir, "agent.exe"))) {
    return res.status(400).send(`No staged build in slot ${idleSlot}. Stage one first.`);
  }

  // build the new junction under a temp name first, so a failure here
  // leaves the existing current untouched
  // see docs/Why.md#why-does-the-commit-handler-build-the-junction-under-a-temp-name-first
  const tempLinkPath = `${CURRENT_LINK}.new`;
  try {
    await fs.rm(tempLinkPath, { force: true });
    await fs.symlink(idleSlotDir, tempLinkPath, "junction");
  } catch (err) {
    return res.status(500).send(`Could not flip to the new build: ${err.message}`);
  }

  try {
    await fs.rm(CURRENT_LINK, { force: true });
    await fs.rename(tempLinkPath, CURRENT_LINK);
  } catch (err) {
    console.error(`Could not move ${tempLinkPath} into place as ${CURRENT_LINK}: ${err.message}. The known-good junction is still at ${tempLinkPath}; rename it to "current" and restart manually.`);
    return res.status(500).send(`Could not flip to the new build: ${err.message}`);
  }

  // deliberate restart, not a crash, see docs/Why.md#why-does-the-agent-use-a-current-junction-instead-of-nssms-own-config
  // skip-exit exists only so a test's http round trip survives it
  if (!process.env.AGENT_SELF_UPDATE_SKIP_EXIT) res.on("finish", () => process.exit(1));
  res.json({ ok: true, activeSlot: idleSlot });
}));

// section: logs, a tail of this agent's own log file
// nssm's own appstdout/appstderr redirection (install.ps1) is what
// actually writes and rotates agent_log_file, this just reads it back

app.get("/logs", checkToken, asyncHandler(async (req, res) => {
  let raw;
  try {
    raw = await fs.readFile(AGENT_LOG_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return res.type("text/plain").send("");
    return res.status(500).send(`Could not read ${AGENT_LOG_FILE}: ${err.message}`);
  }
  const lines = raw.split("\n").filter(Boolean).slice(-MAX_LOG_READ_LINES);
  res.type("text/plain").send(lines.join("\n"));
}));

// anything not matched above is a plain 404
app.use((req, res) => res.status(404).send("Not found."));

// must be registered last, after every route and the 404 above
// see docs/Why.md#why-does-every-async-handler-need-asynchandler
app.use(errorHandler);

// only listen when run directly, tests import the app instead
// see docs/Why.md#why-doesnt-the-control-port-proxy-handle-websocket-upgrades
if (require.main === module) {
  // undefined (bind-all) unless install.ps1 narrowed it with
  // -AgentBindAddress, see docs/Why.md#why-are-bind-address-and-firewall-remote-address-two-separate-install-params
  const bindAddress = process.env.AGENT_BIND_ADDRESS || undefined;
  app.listen(PORT, bindAddress, () => {
    console.log(`mission-agent listening on ${bindAddress || "0.0.0.0"}:${PORT}`);
  });
  process.on("unhandledRejection", (reason) => logFatalAndExit("unhandledRejection", reason));
  process.on("uncaughtException", (err) => logFatalAndExit("uncaughtException", err));
}

// expose the express app itself, for both real use and tests
module.exports = app;
