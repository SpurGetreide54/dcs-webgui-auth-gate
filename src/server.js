const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const tar = require("tar");
const db = require("./db");
const auth = require("./auth");
const serversDb = require("./servers");
const views = require("./views");
const controlTokens = require("./controlTokens");
const serverProxy = require("./serverProxy");

const PORT = Number(process.env.PORT || 3000);
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false"; // Default true. Disable only for local http dev.

const app = express();
app.disable("x-powered-by");
// Trust exactly one hop (nginx), not the whole chain. nginx's
// $proxy_add_x_forwarded_for appends to X-Forwarded-For rather than
// replacing it, so trusting the full chain would let a client spoof
// req.ip with their own header and dodge the login rate limiter.
app.set("trust proxy", 1);
app.use(cookieParser());
app.use("/assets", express.static(path.join(__dirname, "..", "public")));
// Browsers request /favicon.ico at the domain root as a fallback whenever
// a page has no <link rel="icon"> of its own -- true of the real DCS
// webgui's index.html, which we don't control. Answering it here avoids
// a stray 404 on every /s/<slug>/ page load; a real .ico isn't required,
// browsers accept any image type regardless of the request's extension.
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "logo.png")));

function adminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM admins").get().n;
}

function setSessionCookie(res, token) {
  res.cookie(auth.SESSION_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

// ---- /setup: only reachable while no admin accounts exist ----

app.get("/setup", (req, res) => {
  if (adminCount() > 0) return res.status(404).send("Not found.");
  res.send(views.setupPage({}));
});

app.post("/setup", express.urlencoded({ extended: false }), (req, res) => {
  if (adminCount() > 0) return res.status(404).send("Not found.");
  const { username, password } = req.body;
  if (!username || !password || password.length < 12) {
    return res.status(400).send(views.setupPage({ error: "Username required, password must be at least 12 characters." }));
  }
  const info = db
    .prepare("INSERT INTO admins (username, password_hash, can_manage_accounts) VALUES (?, ?, 1)")
    .run(username, auth.hashPassword(password));
  serversDb.grantAllServers(info.lastInsertRowid, { canUploadMissions: true });
  const token = auth.createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.redirect("/");
});

// ---- /login, /logout ----

app.get("/login", (req, res) => {
  if (adminCount() === 0) return res.redirect("/setup");
  res.send(views.loginPage({}));
});

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).send(views.loginPage({ error: "Username and password required." }));
  }
  if (auth.isRateLimited(req, username)) {
    return res.status(429).send(views.loginPage({ error: "Too many attempts. Try again later." }));
  }
  auth.pruneOldLoginAttempts();
  auth.recordLoginAttempt(req, username);

  const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
    return res.status(401).send(views.loginPage({ error: "Invalid username or password." }));
  }
  const token = auth.createSession(admin.id);
  setSessionCookie(res, token);
  res.redirect("/");
});

app.post("/logout", express.urlencoded({ extended: false }), (req, res) => {
  auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE);
  res.redirect("/login");
});

// ---- everything below requires a session ----

app.use(auth.requireAuth);

app.get("/", (req, res) => {
  const servers = serversDb.getAccessibleServers(req.admin.id);
  res.send(views.dashboardPage({ admin: req.admin, servers }));
});

// ---- account management: full page for site admins, read-only "My
// account" + self-service password change for everyone else ----

const accountsRouter = express.Router();
// No blanket requireAccountManager gate here -- GET / and the
// change-password route are for every admin (see accountsPage()'s
// site-admin/self-service branch). Every mutation that touches another
// account, or account creation, gets requireAccountManager on its own
// route below instead.

function loadAccountsPageData(req, { error, notice } = {}) {
  const servers = serversDb.getAllServers();
  if (!req.admin.can_manage_accounts) {
    const own = { username: req.admin.username, access: serversDb.getAccessibleServers(req.admin.id) };
    return views.accountsPage({ admin: req.admin, own, servers, error, notice });
  }
  const accounts = db
    .prepare("SELECT id, username, can_manage_accounts FROM admins ORDER BY id")
    .all()
    .map((a) => ({ ...a, access: serversDb.getAccessibleServers(a.id) }));
  return views.accountsPage({ admin: req.admin, accounts, servers, error, notice });
}

accountsRouter.get("/", (req, res) => {
  res.send(loadAccountsPageData(req));
});

// Self-service: change the logged-in admin's own password. Available to
// every admin, not just site admins, which is why this isn't under
// requireAccountManager. Signs out every other session for this account --
// the point of requiring the current password is letting the real owner
// kick out anyone (or anything hijacked) still logged in elsewhere.
accountsRouter.post("/change-password", express.urlencoded({ extended: false }), (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).send(loadAccountsPageData(req, { error: "All password fields are required." }));
  }
  if (!auth.verifyPassword(current_password, req.admin.password_hash)) {
    return res.status(400).send(loadAccountsPageData(req, { error: "Current password is incorrect." }));
  }
  if (new_password.length < 12) {
    return res.status(400).send(loadAccountsPageData(req, { error: "New password must be at least 12 characters." }));
  }
  if (new_password !== confirm_password) {
    return res.status(400).send(loadAccountsPageData(req, { error: "New password and confirmation do not match." }));
  }
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(auth.hashPassword(new_password), req.admin.id);
  const currentToken = req.cookies[auth.SESSION_COOKIE];
  db.prepare("DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?").run(req.admin.id, auth.hashToken(currentToken));
  res.send(loadAccountsPageData(req, { notice: "Password changed. You're still signed in here; any other sessions were signed out." }));
});

// ---- everything below is site-admin only ----

accountsRouter.post("/", auth.requireAccountManager, express.urlencoded({ extended: false }), (req, res) => {
  const { username, password, can_manage_accounts } = req.body;
  if (!username || !password || password.length < 12) {
    return res.status(400).send(loadAccountsPageData(req, { error: "Username required, password must be at least 12 characters." }));
  }
  let info;
  try {
    info = db
      .prepare("INSERT INTO admins (username, password_hash, can_manage_accounts) VALUES (?, ?, ?)")
      .run(username, auth.hashPassword(password), can_manage_accounts ? 1 : 0);
  } catch (err) {
    return res.status(400).send(loadAccountsPageData(req, { error: "That username is already taken." }));
  }
  for (const server of serversDb.getAllServers()) {
    const wantsAccess = Boolean(req.body[`access_${server.id}`]);
    const wantsUpload = Boolean(req.body[`upload_${server.id}`]);
    if (wantsAccess) serversDb.setAccess(info.lastInsertRowid, server.id, { canUploadMissions: wantsUpload });
  }
  res.redirect("/admin/accounts");
});

accountsRouter.post("/:id", express.urlencoded({ extended: false }), (req, res) => {
  const targetId = Number(req.params.id);
  const canManage = Boolean(req.body.can_manage_accounts);

  if (!canManage) {
    const remainingManagers = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE can_manage_accounts = 1 AND id != ?")
      .get(targetId).n;
    if (remainingManagers === 0) {
      return res.status(400).send(loadAccountsPageData(req, { error: "Can't remove the last site admin's account-management access." }));
    }
  }
  db.prepare("UPDATE admins SET can_manage_accounts = ? WHERE id = ?").run(canManage ? 1 : 0, targetId);

  for (const server of serversDb.getAllServers()) {
    const wantsAccess = Boolean(req.body[`access_${server.id}`]);
    const wantsUpload = Boolean(req.body[`upload_${server.id}`]);
    if (wantsAccess) {
      serversDb.setAccess(targetId, server.id, { canUploadMissions: wantsUpload });
    } else {
      serversDb.revokeAccess(targetId, server.id);
    }
  }
  res.redirect("/admin/accounts");
});

accountsRouter.post("/:id/delete", (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare("SELECT * FROM admins WHERE id = ?").get(targetId);
  if (!target) return res.status(404).send(loadAccountsPageData(req, { error: "No such account." }));

  if (target.can_manage_accounts) {
    const remainingManagers = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE can_manage_accounts = 1 AND id != ?")
      .get(targetId).n;
    if (remainingManagers === 0) {
      return res.status(400).send(loadAccountsPageData(req, { error: "Can't delete the last site admin's account." }));
    }
  }
  db.prepare("DELETE FROM admins WHERE id = ?").run(targetId);
  res.redirect("/admin/accounts");
});

app.use("/admin/accounts", accountsRouter);

// ---- server management (site admins only) ----

const SLUG_RE = /^[a-z0-9-]+$/;
// Must match the real Windows DCS instance folder name under Saved Games,
// e.g. "Example_Training", or the DCS default "DCS.dcs_serverrelease".
// Dots are normal here. Only a string of dots alone (".", "..") is
// rejected, not dots in general. No slashes/backslashes -- the agent
// builds filesystem paths from this. Kept in sync with agent.js.
const INSTANCE_NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]+$/;
const DEFAULT_INSTANCE_NAME = "DCS.dcs_serverrelease";

const serversRouter = express.Router();
serversRouter.use(auth.requireAccountManager);

function loadServersPageData(req, { error, notice } = {}) {
  return views.serversPage({ admin: req.admin, servers: serversDb.getAllServers(), error, notice });
}

serversRouter.get("/", (req, res) => {
  res.send(loadServersPageData(req));
});

serversRouter.post("/", express.urlencoded({ extended: false }), (req, res) => {
  const { slug, name, instance_name, dcs_install_path } = req.body;
  if (!slug || !name || !instance_name) {
    return res.status(400).send(loadServersPageData(req, { error: "All fields are required." }));
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).send(loadServersPageData(req, { error: "Slug must be lowercase letters, numbers, and hyphens only (it becomes part of the URL: /s/<slug>/)." }));
  }
  if (!INSTANCE_NAME_RE.test(instance_name)) {
    return res.status(400).send(loadServersPageData(req, { error: "DCS instance name must be letters, numbers, underscores, and hyphens only." }));
  }
  const installPath = dcs_install_path && dcs_install_path.trim() ? dcs_install_path.trim() : null;

  try {
    db.prepare("INSERT INTO servers (slug, name, instance_name, dcs_install_path) VALUES (?, ?, ?, ?)").run(slug, name, instance_name, installPath);
  } catch (err) {
    return res.status(400).send(loadServersPageData(req, { error: "That slug is already in use." }));
  }
  res.send(
    loadServersPageData(req, {
      notice: `Created "${name}". No admin has access to it yet — grant access from Manage accounts. "${instance_name}" must match the real DCS instance folder name under Saved Games on the host, or the webgui and mission uploads won't find it.`,
    })
  );
});

serversRouter.post("/:id", express.urlencoded({ extended: false }), (req, res) => {
  const targetId = Number(req.params.id);
  const { name, instance_name, dcs_install_path } = req.body;
  if (!name || !instance_name) {
    return res.status(400).send(loadServersPageData(req, { error: "All fields are required." }));
  }
  if (!INSTANCE_NAME_RE.test(instance_name)) {
    return res.status(400).send(loadServersPageData(req, { error: "DCS instance name must be letters, numbers, underscores, and hyphens only." }));
  }
  const installPath = dcs_install_path && dcs_install_path.trim() ? dcs_install_path.trim() : null;

  db.prepare("UPDATE servers SET name = ?, instance_name = ?, dcs_install_path = ? WHERE id = ?").run(name, instance_name, installPath, targetId);
  res.redirect("/admin/servers");
});

serversRouter.post("/:id/delete", (req, res) => {
  const targetId = Number(req.params.id);
  // admin_server_access rows for this server cascade-delete automatically
  // via ON DELETE CASCADE in the schema. No separate cleanup needed here.
  db.prepare("DELETE FROM servers WHERE id = ?").run(targetId);
  res.redirect("/admin/servers");
});

// ---- webgui control-port assignment: review + explicit confirm before
// ever writing to a server's own autoexec.cfg on the physical host ----

async function agentStatus(instanceName) {
  const url = new URL(`/webgui/${encodeURIComponent(instanceName)}/status`, MISSION_AGENT_URL);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` } });
  if (!res.ok) throw new Error(`agent returned ${res.status} for ${instanceName}`);
  return res.json();
}

async function buildWebguiPortProposal() {
  const servers = serversDb.getAllServers();
  const statuses = await Promise.all(
    servers.map(async (server) => ({ server, ...(await agentStatus(server.instance_name)) }))
  );

  const usedPorts = new Set(statuses.filter((s) => s.webguiPort !== null).map((s) => s.webguiPort));
  const missing = statuses.filter((s) => s.webguiPort === null);

  let candidate = 8088;
  const proposals = missing.map((s) => {
    while (usedPorts.has(candidate)) candidate++;
    usedPorts.add(candidate);
    return { server: s.server, proposedPort: candidate++ };
  });

  return { alreadyConfigured: statuses.filter((s) => s.webguiPort !== null), proposals };
}

serversRouter.get("/webgui-ports", async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    return res.status(500).send(loadServersPageData(req, { error: "Mission agent is not configured." }));
  }
  try {
    const { proposals } = await buildWebguiPortProposal();
    res.send(views.webguiPortsPage({ admin: req.admin, proposals }));
  } catch (err) {
    res.status(502).send(loadServersPageData(req, { error: `Could not reach the mission agent: ${err.message}` }));
  }
});

serversRouter.post("/webgui-ports/confirm", async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    return res.status(500).send(loadServersPageData(req, { error: "Mission agent is not configured." }));
  }
  try {
    const { proposals } = await buildWebguiPortProposal();
    for (const { server, proposedPort } of proposals) {
      const url = new URL(`/webgui/${encodeURIComponent(server.instance_name)}/ensure-port`, MISSION_AGENT_URL);
      const agentRes = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ port: proposedPort }),
      });
      if (!agentRes.ok) throw new Error(`agent returned ${agentRes.status} for ${server.instance_name}`);
    }
    res.send(
      loadServersPageData(req, {
        notice:
          proposals.length === 0
            ? "No servers needed a webgui port assigned."
            : `Assigned webgui ports for: ${proposals.map((p) => `${p.server.name} (${p.proposedPort})`).join(", ")}.`,
      })
    );
  } catch (err) {
    res.status(502).send(loadServersPageData(req, { error: `Could not reach the mission agent: ${err.message}` }));
  }
});

// ---- webgui bundle sync ----
// Pulls the real DCS webgui SPA straight out of a DCS World Server install
// already on the host, instead of an admin copying their own legitimate
// copy into webgui-static/ by hand. Explicit admin action, same shape as
// webgui-ports above -- a silent DCS update on the host must not silently
// change what every admin sees. webgui-static/ stays a single shared
// folder for every server slug. The admin just picks which configured
// server to sync *from*.

async function fetchWebguiBundle(installPath) {
  const url = new URL("/dcs-install/webgui-bundle", MISSION_AGENT_URL);
  url.searchParams.set("path", installPath);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` } });
  if (!res.ok) {
    throw new Error(`agent returned ${res.status}: ${await res.text()}`);
  }
  return res;
}

serversRouter.get("/webgui-sync", (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    return res.status(500).send(loadServersPageData(req, { error: "Mission agent is not configured." }));
  }
  res.send(views.webguiSyncPage({ admin: req.admin, servers: serversDb.getAllServers() }));
});

// Two path segments deliberately. A single-segment "/webgui-sync" would be
// shadowed by the earlier POST "/:id" route above -- Express matches ":id"
// against the literal string "webgui-sync". Same reason webgui-ports' own
// confirm route is "/webgui-ports/confirm" rather than a bare POST
// "/webgui-ports".
serversRouter.post("/webgui-sync/confirm", express.urlencoded({ extended: false }), async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    return res.status(500).send(loadServersPageData(req, { error: "Mission agent is not configured." }));
  }
  const server = serversDb.getServerById(Number(req.body.server_id));
  if (!server || !server.dcs_install_path) {
    return res.status(400).send(
      views.webguiSyncPage({
        admin: req.admin,
        servers: serversDb.getAllServers(),
        error: "Pick a server that has a DCS install path set.",
      })
    );
  }

  // Extract into a scratch dir first and validate it before touching the
  // live webgui-static/ at all. Then swap via two renames -- fast, same
  // filesystem -- with a restore-on-failure path. A bad path, a
  // mid-transfer failure, or a bundle missing index.html must never leave
  // /s/:slug/ serving a half-replaced or missing bundle. The scratch dir
  // has to be a sibling of webguiRoot, not e.g. somewhere under
  // local-only/: rename() across filesystems fails with EXDEV, and
  // WEBGUI_STATIC_PATH can point anywhere, so nothing guarantees they'd
  // share one otherwise.
  const tmpDir = `${webguiRoot}.sync-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const hadExisting = fsSync.existsSync(webguiRoot);
  const backupDir = `${webguiRoot}.sync-backup-${Date.now()}`;

  try {
    const bundleRes = await fetchWebguiBundle(server.dcs_install_path);
    await fs.mkdir(tmpDir, { recursive: true });
    await pipeline(Readable.fromWeb(bundleRes.body), tar.x({ cwd: tmpDir }));
    await fs.access(path.join(tmpDir, "index.html"));

    if (hadExisting) await fs.rename(webguiRoot, backupDir);
    try {
      await fs.rename(tmpDir, webguiRoot);
    } catch (renameErr) {
      if (hadExisting) await fs.rename(backupDir, webguiRoot);
      throw renameErr;
    }
    if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });

    webguiIndexTemplate = loadWebguiIndexTemplate(webguiRoot);

    res.send(
      views.webguiSyncPage({
        admin: req.admin,
        servers: serversDb.getAllServers(),
        notice: `Synced webgui-static/ from "${server.name}"'s DCS install (${server.dcs_install_path}).`,
      })
    );
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    res.status(502).send(
      views.webguiSyncPage({
        admin: req.admin,
        servers: serversDb.getAllServers(),
        error: `Sync failed: ${err.message}`,
      })
    );
  }
});

app.use("/admin/servers", serversRouter);

// ---- per-server: access check, mission upload, then generic proxy ----

function requireServerAccess({ upload }) {
  return (req, res, next) => {
    const server = serversDb.getServerBySlug(req.params.slug);
    if (!server) return res.status(404).send("Unknown server.");
    const access = serversDb.getAccess(req.admin.id, server.id);
    if (!access || (upload && !access.can_upload_missions)) {
      return res.status(403).send("Forbidden: you don't have access to this server.");
    }
    req.dcsServer = server;
    next();
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    cb(null, file.originalname.toLowerCase().endsWith(".miz"));
  },
});

app.get("/s/:slug/missions", requireServerAccess({ upload: true }), (req, res) => {
  res.send(views.missionsPage({ admin: req.admin, server: req.dcsServer }));
});

app.post(
  "/s/:slug/missions/upload",
  requireServerAccess({ upload: true }),
  (req, res, next) => {
    upload.single("mission")(req, res, (err) => {
      if (err) return res.status(400).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, error: err.message }));
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(400).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, error: "No .miz file provided." }));
    }
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
      return res.status(500).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, error: "Mission agent is not configured." }));
    }
    try {
      const form = new FormData();
      form.append("instance_name", req.dcsServer.instance_name);
      form.append(
        "mission",
        new Blob([req.file.buffer], { type: "application/octet-stream" }),
        req.file.originalname
      );
      const agentRes = await fetch(new URL("/upload", MISSION_AGENT_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` },
        body: form,
      });
      if (!agentRes.ok) {
        const detail = await agentRes.text().catch(() => "");
        return res.status(502).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, error: `Mission agent rejected the upload: ${detail || agentRes.status}` }));
      }
    } catch (err) {
      return res.status(502).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, error: `Could not reach the mission agent: ${err.message}` }));
    }
    res.send(views.missionsPage({ admin: req.admin, server: req.dcsServer, notice: `Uploaded ${req.file.originalname}.` }));
  }
);

// The real DCS webgui is a static SPA with no server of its own. Opened as
// a local file, its own connection logic tries to reach a backend at
// whatever host/port it decides on -- undocumented, and not necessarily
// even the page's own hostname:port. Rather than guess that logic, this
// rewrites it at the network layer: any fetch() that isn't for one of the
// app's own static files under /s/<slug>/ gets redirected to the one
// shared control-port proxy, with a short-lived per-load token attached
// (see controlTokens.js) in place of a cookie. Cross-port/cross-origin
// fetch() doesn't carry cookies by default, even though the cookie itself
// is host-scoped, so a plain reverse proxy would have nothing to authorize
// the connection with.

// webgui-static/ is deliberately gitignored, not shipped in this repo. The
// real DCS webgui is shared-source, not open source. Redistributing it is
// not allowed. Each deployment has to populate this directory itself, from
// its own legitimate copy. Its absence is an expected state on a fresh
// checkout, not a bug, and must not take the rest of the app down --
// login/accounts/servers admin should all still work before it's in place.
const webguiRoot = process.env.WEBGUI_STATIC_PATH || path.join(__dirname, "..", "webgui-static");

// Matches the app.js script tag regardless of quoting style or whitespace.
// A real DCS webgui build ships this minified -- no quotes around the src
// attribute (<script src=js/app.js></script>) -- which an exact literal-
// string match misses entirely and silently. A silent miss here means the
// bootstrap below never gets injected: app.js runs with native fetch(),
// talks straight to 127.0.0.1 instead of the control-port proxy, and every
// admin just sees "server not responding" with no error anywhere.
const APP_JS_SCRIPT_RE = /<script\s+src=["']?js\/app\.js["']?\s*>\s*<\/script>/;

function loadWebguiIndexTemplate(root) {
  let template;
  try {
    template = fsSync.readFileSync(path.join(root, "index.html"), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.warn(
      `webgui-static/index.html not found — /s/<slug>/ will return 503 until it's populated. ` +
        `The real DCS webgui is shared-source and can't be shipped in this repo; copy your own ` +
        `legitimate copy (index.html, styles.css, js/, fonts/, images/, lang/) into webgui-static/.`
    );
    return null;
  }
  if (!APP_JS_SCRIPT_RE.test(template)) {
    console.warn(
      `webgui-static/index.html doesn't contain the expected <script src="js/app.js"> tag in any ` +
        `recognized form. The fetch-rewrite bootstrap will NOT be injected -- /s/<slug>/ will still ` +
        `serve normally, but the DCS webgui will talk straight to 127.0.0.1 instead of the ` +
        `control-port proxy, and just show "server not responding" with no visible error. This DCS ` +
        `webgui build's markup may not match what this app expects; check webgui-static/index.html by hand.`
    );
  }
  return template;
}

let webguiIndexTemplate = loadWebguiIndexTemplate(webguiRoot);

app.get("/s/:slug/", requireServerAccess({ upload: false }), (req, res) => {
  if (!webguiIndexTemplate) {
    return res.status(503).send("The DCS webgui bundle is not installed on this server yet.");
  }
  const token = controlTokens.mint(req.admin.id, req.dcsServer.id);
  const bootstrap = `<script>
  (function () {
    var TOKEN = ${JSON.stringify(token)};
    var CONTROL_PORT = ${JSON.stringify(String(serverProxy.CONTROL_PORT))};
    var BASE_PATH = ${JSON.stringify(`/s/${req.params.slug}/`)};
    function rewriteIfBackendCall(url) {
      var target;
      try {
        // The real DCS webgui's own default backend URL is malformed --
        // "http://127.0.0.1\\:8088/..." with a literal backslash before the
        // port colon. Per the URL spec, a backslash right after the host
        // ends authority parsing for http(s) URLs, so the port number never
        // gets recognized as a port at all -- it falls into the path
        // instead ("/8088/encryptedRequest"), which then rides along
        // untouched through the rewrite below and shows up doubled next to
        // the port we do set correctly. Undo that one specific escape
        // before parsing, so the URL's own port is what wins.
        //
        // Quadruple/double backslashes below, not the single/double a
        // plain regex would use: this whole block is itself a JS template
        // literal in server.js. \\d is not a recognized string escape, so
        // Node's own parser silently drops the backslash and ships the
        // browser a regex that can never match a digit -- confirmed with
        // node -e before writing this the second time. This exact count
        // survives that first unescaping and reaches the browser as the
        // literal regex /\\+:(\d+)/.
        target = new URL(url.replace(/\\\\+:(\\d+)/, ":$1"), location.href);
      } catch (e) {
        return null;
      }
      // Anything for one of the app's own served files (same-origin, under
      // BASE_PATH) stays untouched. Everything else -- same-host on a
      // different path, or a hardcoded absolute host like the real DCS
      // webgui's own 127.0.0.1 -- is the app trying to reach its live
      // backend.
      if (target.hostname === location.hostname && target.pathname.indexOf(BASE_PATH) === 0) return null;
      target.protocol = location.protocol;
      target.hostname = location.hostname;
      target.port = CONTROL_PORT;
      return target.toString();
    }
    // The real DCS webgui's own control-port discovery call
    // (ACTION=GetJSONData) only exists to hand back { address, webPort,
    // webKey } so the app can set its live backend URL and derive its
    // AES key from webKey. The app's own code already skips this call
    // entirely when opened via file:// or localhost, hardcoding this
    // exact response instead -- webKey is a fixed, publicly known
    // constant baked into every DCS install (never a per-server secret),
    // not something that needs a real round trip. Mirroring that same
    // shortcut here, for the reverse-proxied case, is exactly as
    // legitimate as the app's own file://+localhost path already is.
    function isControlPortDiscoveryCall(url) {
      return /[?&]ACTION=GetJSONData(?:&|$)/.test(url);
    }
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input.url;
      if (isControlPortDiscoveryCall(url)) {
        var body = JSON.stringify({ address: "127.0.0.1", webPort: Number(CONTROL_PORT), webKey: "DigitalCombatSimulator.com" });
        return Promise.resolve(new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      var rewritten = rewriteIfBackendCall(url);
      if (rewritten) {
        init = Object.assign({}, init);
        init.headers = new Headers(init.headers || {});
        init.headers.set("X-Auth-Gate-Token", TOKEN);
        return nativeFetch.call(this, rewritten, init);
      }
      return nativeFetch.call(this, input, init);
    };
  })();
</script>`;
  res.set("Content-Type", "text/html");
  res.send(webguiIndexTemplate.replace(APP_JS_SCRIPT_RE, `${bootstrap}\n  <script src="js/app.js"></script>`));
});

app.use("/s/:slug", requireServerAccess({ upload: false }), express.static(webguiRoot, { index: false }));

app.use((req, res) => res.status(404).send("Not found."));

if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    console.log(`dcs-webgui-auth-gate listening on :${PORT}`);
  });
  const controlProxyServer = serverProxy.startControlProxy();
  // Explicit db.close() on shutdown, not just process exit. Leaving
  // better-sqlite3's native handles to GC/finalizers has crashed the
  // process during teardown instead of exiting cleanly.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      controlProxyServer.close(() => {
        httpServer.close(() => {
          db.close();
          process.exit(0);
        });
      });
    });
  }
}

module.exports = app;
