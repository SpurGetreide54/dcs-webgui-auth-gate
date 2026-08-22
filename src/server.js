const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("node:path");
const fs = require("node:fs/promises");
const db = require("./db");
const auth = require("./auth");
const serversDb = require("./servers");
const views = require("./views");

const PORT = Number(process.env.PORT || 3000);
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false"; // default true; only disable for local http dev

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // sits behind nginx
app.use(cookieParser());
app.use("/assets", express.static(path.join(__dirname, "..", "public")));

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

app.get("/logout", (req, res) => {
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

// ---- account management (site admins only) ----

const accountsRouter = express.Router();
accountsRouter.use(auth.requireAccountManager);

function loadAccountsPageData(req, { error, notice } = {}) {
  const servers = serversDb.getAllServers();
  const accounts = db
    .prepare("SELECT id, username, can_manage_accounts FROM admins ORDER BY id")
    .all()
    .map((a) => ({ ...a, access: serversDb.getAccessibleServers(a.id) }));
  return views.accountsPage({ admin: req.admin, accounts, servers, error, notice });
}

accountsRouter.get("/", (req, res) => {
  res.send(loadAccountsPageData(req));
});

accountsRouter.post("/", express.urlencoded({ extended: false }), (req, res) => {
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
const FOLDER_KEY_RE = /^[a-z0-9-]+$/;

const serversRouter = express.Router();
serversRouter.use(auth.requireAccountManager);

function loadServersPageData(req, { error, notice } = {}) {
  return views.serversPage({ admin: req.admin, servers: serversDb.getAllServers(), error, notice });
}

serversRouter.get("/", (req, res) => {
  res.send(loadServersPageData(req));
});

serversRouter.post("/", express.urlencoded({ extended: false }), (req, res) => {
  const { slug, name, upstream_url, mission_folder_key } = req.body;
  if (!slug || !name || !upstream_url || !mission_folder_key) {
    return res.status(400).send(loadServersPageData(req, { error: "All fields are required." }));
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).send(loadServersPageData(req, { error: "Slug must be lowercase letters, numbers, and hyphens only (it becomes part of the URL: /s/<slug>/)." }));
  }
  if (!FOLDER_KEY_RE.test(mission_folder_key)) {
    return res.status(400).send(loadServersPageData(req, { error: "Mission folder key must be lowercase letters, numbers, and hyphens only." }));
  }
  let parsedUpstream;
  try {
    parsedUpstream = new URL(upstream_url);
  } catch {
    return res.status(400).send(loadServersPageData(req, { error: "Upstream URL is not a valid URL." }));
  }
  if (!["http:", "https:"].includes(parsedUpstream.protocol)) {
    return res.status(400).send(loadServersPageData(req, { error: "Upstream URL must be http:// or https://." }));
  }

  try {
    db.prepare(
      "INSERT INTO servers (slug, name, upstream_url, mission_folder_key) VALUES (?, ?, ?, ?)"
    ).run(slug, name, upstream_url, mission_folder_key);
  } catch (err) {
    return res.status(400).send(loadServersPageData(req, { error: "That slug is already in use." }));
  }
  res.send(
    loadServersPageData(req, {
      notice: `Created "${name}". No admin has access to it yet — grant access from Manage accounts. The mission-agent on the physical host must also have a matching MISSION_FOLDER_${mission_folder_key.toUpperCase()} configured before uploads to it will work.`,
    })
  );
});

serversRouter.post("/:id", express.urlencoded({ extended: false }), (req, res) => {
  const targetId = Number(req.params.id);
  const { name, upstream_url, mission_folder_key } = req.body;
  if (!name || !upstream_url || !mission_folder_key) {
    return res.status(400).send(loadServersPageData(req, { error: "All fields are required." }));
  }
  if (!FOLDER_KEY_RE.test(mission_folder_key)) {
    return res.status(400).send(loadServersPageData(req, { error: "Mission folder key must be lowercase letters, numbers, and hyphens only." }));
  }
  let parsedUpstream;
  try {
    parsedUpstream = new URL(upstream_url);
  } catch {
    return res.status(400).send(loadServersPageData(req, { error: "Upstream URL is not a valid URL." }));
  }
  if (!["http:", "https:"].includes(parsedUpstream.protocol)) {
    return res.status(400).send(loadServersPageData(req, { error: "Upstream URL must be http:// or https://." }));
  }

  db.prepare("UPDATE servers SET name = ?, upstream_url = ?, mission_folder_key = ? WHERE id = ?").run(
    name,
    upstream_url,
    mission_folder_key,
    targetId
  );
  res.redirect("/admin/servers");
});

serversRouter.post("/:id/delete", (req, res) => {
  const targetId = Number(req.params.id);
  // admin_server_access rows for this server cascade-delete automatically
  // (ON DELETE CASCADE in the schema); no separate cleanup needed here.
  db.prepare("DELETE FROM servers WHERE id = ?").run(targetId);
  res.redirect("/admin/servers");
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
      form.append("folder_key", req.dcsServer.mission_folder_key);
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

app.use(
  "/s/:slug",
  requireServerAccess({ upload: false }),
  createProxyMiddleware({
    router: (req) => req.dcsServer.upstream_url,
    pathRewrite: (path, req) => {
      const prefix = `/s/${req.params.slug}`;
      const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      return rest || "/";
    },
    changeOrigin: true,
    on: {
      error(err, req, res) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end(`Could not reach the DCS server: ${err.message}`);
      },
    },
  })
);

app.use((req, res) => res.status(404).send("Not found."));

if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    console.log(`dcs-webgui-auth-gate listening on :${PORT}`);
  });
  // Explicit db.close() on shutdown, not just process exit: leaving it to
  // GC/finalizers to close better-sqlite3's native handles has been observed
  // to crash the process during teardown rather than exiting cleanly.
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      httpServer.close(() => {
        db.close();
        process.exit(0);
      });
    });
  }
}

module.exports = app;
