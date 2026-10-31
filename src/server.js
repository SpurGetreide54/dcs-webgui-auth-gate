// express and its middleware, node built-ins, and every src/ module
// this app wires together
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("node:path");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const tar = require("tar");
const util = require("node:util");
const db = require("./db");
const auth = require("./auth");
const serversDb = require("./servers");
const invitesDb = require("./invites");
const views = require("./views");
const controlTokens = require("./controlTokens");
const serverProxy = require("./serverProxy");
const updateCheck = require("./updateCheck");
const settings = require("./settings");
const appLog = require("./appLog");
const flash = require("./flash");

appLog.installConsoleCapture();

const PORT = Number(process.env.PORT || 3000);
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;
const MAX_MISSION_BYTES = Number(process.env.MAX_MISSION_BYTES || 200 * 1024 * 1024);
// default true, disable only for local http dev
const COOKIE_SECURE = process.env.COOKIE_SECURE !== "false";

const app = express();
// drop the x-powered-by header, no need to advertise the framework
app.disable("x-powered-by");
// trust exactly one hop (nginx), not the whole chain
// see docs/Why.md#why-does-the-app-trust-exactly-one-proxy-hop
app.set("trust proxy", 1);
app.use(cookieParser());
// a short cache lifetime kills the icon placeholder flash on reload
// see docs/Why.md#why-do-static-assets-get-a-1-day-cache-lifetime
app.use("/assets", express.static(path.join(__dirname, "..", "public"), { maxAge: "1d" }));
// answers the browser's own /favicon.ico fallback request, so a page
// with no <link rel="icon"> of its own (the real dcs webgui) doesn't 404
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "logo.png")));

// express 4 can't catch a rejected promise on its own, so every async
// handler below is wrapped in this to forward the rejection to next()
// see docs/Why.md#why-does-every-async-handler-need-asynchandler
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// how many admin accounts exist, used to gate /setup
function adminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM admins").get().n;
}

// set the session cookie with this app's own fixed options
function setSessionCookie(res, token) {
  res.cookie(auth.SESSION_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
  });
}

// section: /setup, only reachable while no admin accounts exist yet

app.get("/setup", (req, res) => {
  if (adminCount() > 0) return res.status(404).send("Not found.");
  res.send(views.setupPage(flash.readFlash(req, res)));
});

app.post("/setup", express.urlencoded({ extended: false }), (req, res) => {
  if (adminCount() > 0) return res.status(404).send("Not found.");
  const { username, password } = req.body;
  if (!username || !password || password.length < 12) {
    flash.setFlash(res, { error: "Username required, password must be at least 12 characters." });
    return res.redirect("/setup");
  }
  const info = db
    .prepare("INSERT INTO admins (username, password_hash, can_manage_accounts) VALUES (?, ?, 1)")
    .run(username, auth.hashPassword(password));
  serversDb.grantAllServers(info.lastInsertRowid, {
    canUploadMissions: true,
    canViewMissions: true,
    canDownloadMissions: true,
    canDeleteMissions: true,
  });
  const token = auth.createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.redirect("/");
});

// section: /login, /logout

app.get("/login", (req, res) => {
  if (adminCount() === 0) return res.redirect("/setup");
  res.send(views.loginPage(flash.readFlash(req, res)));
});

app.post("/login", express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    flash.setFlash(res, { error: "Username and password required." });
    return res.redirect("/login");
  }
  if (auth.isRateLimited(req, username)) {
    flash.setFlash(res, { error: "Too many attempts. Try again later." });
    return res.redirect("/login");
  }
  auth.pruneOldLoginAttempts();
  auth.pruneExpiredSessions();
  auth.recordLoginAttempt(req, username);

  const admin = db.prepare("SELECT * FROM admins WHERE username = ?").get(username);
  // always run one real bcrypt compare, known username or not
  // see docs/Why.md#why-is-verifypassword-async-but-hashpassword-isnt
  const passwordOk = await auth.verifyPassword(password, admin ? admin.password_hash : auth.DUMMY_PASSWORD_HASH);
  if (!admin || !passwordOk) {
    flash.setFlash(res, { error: "Invalid username or password." });
    return res.redirect("/login");
  }
  auth.clearLoginAttempts(req, username);
  const token = auth.createSession(admin.id);
  setSessionCookie(res, token);
  res.redirect("/");
}));

app.post("/logout", express.urlencoded({ extended: false }), (req, res) => {
  auth.destroySession(req.cookies[auth.SESSION_COOKIE]);
  res.clearCookie(auth.SESSION_COOKIE);
  res.redirect("/login");
});

// section: /invite/:token, redeeming an account-creation invite
// unauthenticated, same tier as /setup and /login, the account being
// created doesn't exist yet

app.get("/invite/:token", (req, res) => {
  const invite = invitesDb.getValidInviteByToken(req.params.token);
  if (!invite) return res.status(404).send(views.inviteExpiredPage());
  res.send(views.invitePage(flash.readFlash(req, res)));
});

app.post("/invite/:token", express.urlencoded({ extended: false }), (req, res) => {
  const invite = invitesDb.getValidInviteByToken(req.params.token);
  if (!invite) return res.status(404).send(views.inviteExpiredPage());

  const { username, password, confirm_password } = req.body;
  if (!username || !password || !confirm_password) {
    flash.setFlash(res, { error: "All fields are required." });
    return res.redirect(`/invite/${req.params.token}`);
  }
  if (password.length < 12) {
    flash.setFlash(res, { error: "Password must be at least 12 characters." });
    return res.redirect(`/invite/${req.params.token}`);
  }
  if (password !== confirm_password) {
    flash.setFlash(res, { error: "Password and confirmation do not match." });
    return res.redirect(`/invite/${req.params.token}`);
  }

  let info;
  try {
    info = db
      .prepare("INSERT INTO admins (username, password_hash, can_manage_accounts) VALUES (?, ?, ?)")
      .run(username, auth.hashPassword(password), invite.can_manage_accounts);
  } catch (err) {
    flash.setFlash(res, { error: "That username is already taken." });
    return res.redirect(`/invite/${req.params.token}`);
  }
  for (const grant of invitesDb.getInviteAccess(invite.id)) {
    serversDb.setAccess(info.lastInsertRowid, grant.server_id, {
      canUploadMissions: grant.can_upload_missions,
      canViewMissions: grant.can_view_missions,
      canDownloadMissions: grant.can_download_missions,
      canDeleteMissions: grant.can_delete_missions,
    });
  }
  invitesDb.deleteInvite(invite.id);

  const token = auth.createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.redirect("/");
});

// everything below here requires a session
app.use(auth.requireAuth(setSessionCookie));

app.get("/", (req, res) => {
  const servers = serversDb.getAccessibleServers(req.admin.id);
  res.send(views.dashboardPage({ admin: req.admin, servers }));
});

// section: account management
// the full page for site admins, read-only "my account" plus
// self-service password change for everyone else

const accountsRouter = express.Router();
// no blanket requireAccountManager gate here, GET / and change-password
// are for every admin, every mutation that touches another account
// gets its own requireAccountManager below instead

// load this request's own view of the accounts page (site admin or not)
function loadAccountsPageData(req, { error, notice, inviteUrl } = {}) {
  const servers = serversDb.getAllServers();
  if (!req.admin.can_manage_accounts) {
    const own = { username: req.admin.username, access: serversDb.getAccessibleServers(req.admin.id) };
    return views.accountsPage({ admin: req.admin, own, servers, error, notice });
  }
  invitesDb.pruneExpired();
  const accounts = db
    .prepare("SELECT id, username, can_manage_accounts FROM admins ORDER BY id")
    .all()
    .map((a) => ({ ...a, access: serversDb.getAccessibleServers(a.id) }));
  const invites = invitesDb.listValidInvites();
  return views.accountsPage({ admin: req.admin, accounts, servers, invites, error, notice, inviteUrl });
}

accountsRouter.get("/", (req, res) => {
  res.send(loadAccountsPageData(req, flash.readFlash(req, res)));
});

// self-service password change, available to every admin
// see docs/Why.md#why-does-changing-your-password-sign-out-every-other-session
accountsRouter.post("/change-password", express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;
  if (!current_password || !new_password || !confirm_password) {
    flash.setFlash(res, { error: "All password fields are required." });
    return res.redirect("/admin/accounts");
  }
  if (!(await auth.verifyPassword(current_password, req.admin.password_hash))) {
    flash.setFlash(res, { error: "Current password is incorrect." });
    return res.redirect("/admin/accounts");
  }
  if (new_password.length < 12) {
    flash.setFlash(res, { error: "New password must be at least 12 characters." });
    return res.redirect("/admin/accounts");
  }
  if (new_password !== confirm_password) {
    flash.setFlash(res, { error: "New password and confirmation do not match." });
    return res.redirect("/admin/accounts");
  }
  db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(auth.hashPassword(new_password), req.admin.id);
  const currentToken = req.cookies[auth.SESSION_COOKIE];
  db.prepare("DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?").run(req.admin.id, auth.hashToken(currentToken));
  flash.setFlash(res, { notice: "Password changed. You're still signed in here; any other sessions were signed out." });
  res.redirect("/admin/accounts");
}));

// everything below here is site-admin only

// permission names the matrix popup may toggle, checked here too,
// belt and suspenders on top of servers.js/invites.js's own checks,
// since this value flows in from a request body
const TOGGLEABLE_PERMISSIONS = new Set(["access", "upload", "view", "download", "delete"]);

// the matrix popup's per-cell toggle for a real account, fetch driven
accountsRouter.post("/:id/permissions", auth.requireAccountManager, express.json(), (req, res) => {
  const targetId = Number(req.params.id);
  const serverId = Number(req.body?.server_id);
  const permission = req.body?.permission;
  const granted = Boolean(req.body?.granted);
  if (!TOGGLEABLE_PERMISSIONS.has(permission)) return res.status(400).json({ error: "Unknown permission." });
  if (!db.prepare("SELECT 1 FROM admins WHERE id = ?").get(targetId)) return res.status(404).json({ error: "No such account." });
  serversDb.setPermission(targetId, serverId, permission, granted);
  res.json({ ok: true });
});

// the same per-cell toggle, for a pending invite instead of a real account
accountsRouter.post("/invites/:id/permissions", auth.requireAccountManager, express.json(), (req, res) => {
  const inviteId = Number(req.params.id);
  const serverId = Number(req.body?.server_id);
  const permission = req.body?.permission;
  const granted = Boolean(req.body?.granted);
  if (!TOGGLEABLE_PERMISSIONS.has(permission)) return res.status(400).json({ error: "Unknown permission." });
  if (!invitesDb.getValidInviteById(inviteId)) return res.status(404).json({ error: "That invite has expired or no longer exists." });
  invitesDb.setInvitePermission(inviteId, serverId, permission, granted);
  res.json({ ok: true });
});

accountsRouter.post("/invite", auth.requireAccountManager, express.urlencoded({ extended: false }), (req, res) => {
  invitesDb.pruneExpired();
  const { token } = invitesDb.createInvite({ canManageAccounts: Boolean(req.body.can_manage_accounts) });
  // starts with no server permissions, granted afterward from the
  // pending invite's own permissions button
  const inviteUrl = `${req.protocol}://${req.get("host")}/invite/${token}`;
  flash.setFlash(res, { inviteUrl });
  res.redirect("/admin/accounts");
});

accountsRouter.post("/invites/:id", auth.requireAccountManager, express.urlencoded({ extended: false }), (req, res) => {
  const inviteId = Number(req.params.id);
  if (!invitesDb.getValidInviteById(inviteId)) {
    flash.setFlash(res, { error: "That invite has expired or no longer exists." });
    return res.redirect("/admin/accounts");
  }
  invitesDb.setCanManageAccounts(inviteId, Boolean(req.body.can_manage_accounts));
  res.redirect("/admin/accounts");
});

accountsRouter.post("/invites/:id/revoke", auth.requireAccountManager, (req, res) => {
  invitesDb.deleteInvite(Number(req.params.id));
  res.redirect("/admin/accounts");
});

accountsRouter.post("/", auth.requireAccountManager, express.urlencoded({ extended: false }), (req, res) => {
  const { username, password, can_manage_accounts } = req.body;
  if (!username || !password || password.length < 12) {
    flash.setFlash(res, { error: "Username required, password must be at least 12 characters." });
    return res.redirect("/admin/accounts");
  }
  try {
    db.prepare("INSERT INTO admins (username, password_hash, can_manage_accounts) VALUES (?, ?, ?)")
      .run(username, auth.hashPassword(password), can_manage_accounts ? 1 : 0);
  } catch (err) {
    flash.setFlash(res, { error: "That username is already taken." });
    return res.redirect("/admin/accounts");
  }
  // starts with no server permissions, granted afterward from the
  // new account's own permissions button
  res.redirect("/admin/accounts");
});

accountsRouter.post("/:id", auth.requireAccountManager, express.urlencoded({ extended: false }), (req, res) => {
  const targetId = Number(req.params.id);
  const canManage = Boolean(req.body.can_manage_accounts);

  if (!canManage) {
    const remainingManagers = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE can_manage_accounts = 1 AND id != ?")
      .get(targetId).n;
    if (remainingManagers === 0) {
      flash.setFlash(res, { error: "Can't remove the last site admin's account-management access." });
      return res.redirect("/admin/accounts");
    }
  }
  db.prepare("UPDATE admins SET can_manage_accounts = ? WHERE id = ?").run(canManage ? 1 : 0, targetId);
  res.redirect("/admin/accounts");
});

accountsRouter.post("/:id/delete", auth.requireAccountManager, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare("SELECT * FROM admins WHERE id = ?").get(targetId);
  if (!target) {
    flash.setFlash(res, { error: "No such account." });
    return res.redirect("/admin/accounts");
  }

  if (target.can_manage_accounts) {
    const remainingManagers = db
      .prepare("SELECT COUNT(*) AS n FROM admins WHERE can_manage_accounts = 1 AND id != ?")
      .get(targetId).n;
    if (remainingManagers === 0) {
      flash.setFlash(res, { error: "Can't delete the last site admin's account." });
      return res.redirect("/admin/accounts");
    }
  }
  db.prepare("DELETE FROM admins WHERE id = ?").run(targetId);
  res.redirect("/admin/accounts");
});

app.use("/admin/accounts", accountsRouter);

// section: server management, site admins only

const SLUG_RE = /^[a-z0-9-]+$/;
// must match the real windows dcs instance folder name under saved
// games, dots are normal, only a string of dots alone is rejected,
// kept in sync with agent.js's own copy of this pattern
const INSTANCE_NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]+$/;
const DEFAULT_INSTANCE_NAME = "DCS.dcs_serverrelease";

const serversRouter = express.Router();
serversRouter.use(auth.requireAccountManager);

// load this request's own view of the servers page
function loadServersPageData(req, { error, notice } = {}) {
  return views.serversPage({ admin: req.admin, servers: serversDb.getAllServers(), error, notice });
}

serversRouter.get("/", (req, res) => {
  res.send(loadServersPageData(req, flash.readFlash(req, res)));
});

serversRouter.post("/", express.urlencoded({ extended: false }), (req, res) => {
  const { slug, name, instance_name, dcs_install_path } = req.body;
  if (!slug || !name || !instance_name) {
    flash.setFlash(res, { error: "All fields are required." });
    return res.redirect("/admin/servers");
  }
  if (!SLUG_RE.test(slug)) {
    flash.setFlash(res, { error: "Slug must be lowercase letters, numbers, and hyphens only (it becomes part of the URL: /s/<slug>/)." });
    return res.redirect("/admin/servers");
  }
  if (!INSTANCE_NAME_RE.test(instance_name)) {
    flash.setFlash(res, { error: "DCS instance name must be letters, numbers, underscores, and hyphens only." });
    return res.redirect("/admin/servers");
  }
  const installPath = dcs_install_path && dcs_install_path.trim() ? dcs_install_path.trim() : null;

  try {
    db.prepare("INSERT INTO servers (slug, name, instance_name, dcs_install_path) VALUES (?, ?, ?, ?)").run(slug, name, instance_name, installPath);
  } catch (err) {
    flash.setFlash(res, { error: "That slug is already in use." });
    return res.redirect("/admin/servers");
  }
  flash.setFlash(res, {
    notice: `Created "${name}". No admin has access to it yet — grant access from Manage accounts. "${instance_name}" must match the real DCS instance folder name under Saved Games on the host, or the webgui and mission uploads won't find it.`,
  });
  res.redirect("/admin/servers");
});

serversRouter.post("/:id", express.urlencoded({ extended: false }), (req, res) => {
  const targetId = Number(req.params.id);
  const { name, instance_name, dcs_install_path } = req.body;
  if (!name || !instance_name) {
    flash.setFlash(res, { error: "All fields are required." });
    return res.redirect("/admin/servers");
  }
  if (!INSTANCE_NAME_RE.test(instance_name)) {
    flash.setFlash(res, { error: "DCS instance name must be letters, numbers, underscores, and hyphens only." });
    return res.redirect("/admin/servers");
  }
  const installPath = dcs_install_path && dcs_install_path.trim() ? dcs_install_path.trim() : null;

  db.prepare("UPDATE servers SET name = ?, instance_name = ?, dcs_install_path = ? WHERE id = ?").run(name, instance_name, installPath, targetId);
  res.redirect("/admin/servers");
});

serversRouter.post("/:id/delete", (req, res) => {
  const targetId = Number(req.params.id);
  // admin_server_access rows for this server cascade-delete via the
  // schema's own ON DELETE CASCADE, no separate cleanup needed
  db.prepare("DELETE FROM servers WHERE id = ?").run(targetId);
  res.redirect("/admin/servers");
});

// section: webgui control-port assignment
// review, then an explicit confirm before ever writing to a server's
// own autoexec.cfg on the physical host

// ask the agent what webgui_port (if any) an instance already has
async function agentStatus(instanceName) {
  const url = new URL(`/webgui/${encodeURIComponent(instanceName)}/status`, MISSION_AGENT_URL);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` } });
  if (!res.ok) throw new Error(`agent returned ${res.status} for ${instanceName}`);
  return res.json();
}

// propose a free port for every server that doesn't already have one
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

serversRouter.get("/webgui-ports", asyncHandler(async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    return res.status(500).send(loadServersPageData(req, { error: "Mission agent is not configured." }));
  }
  try {
    const { proposals } = await buildWebguiPortProposal();
    res.send(views.webguiPortsPage({ admin: req.admin, proposals }));
  } catch (err) {
    res.status(502).send(loadServersPageData(req, { error: `Could not reach the mission agent: ${err.message}` }));
  }
}));

serversRouter.post("/webgui-ports/confirm", asyncHandler(async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    flash.setFlash(res, { error: "Mission agent is not configured." });
    return res.redirect("/admin/servers");
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
    flash.setFlash(res, {
      notice:
        proposals.length === 0
          ? "No servers needed a webgui port assigned."
          : `Assigned webgui ports for: ${proposals.map((p) => `${p.server.name} (${p.proposedPort})`).join(", ")}.`,
    });
    res.redirect("/admin/servers");
  } catch (err) {
    flash.setFlash(res, { error: `Could not reach the mission agent: ${err.message}` });
    res.redirect("/admin/servers");
  }
}));

// section: webgui bundle sync
// pulls the real dcs webgui spa out of a dcs world server install
// already on the host, see docs/Why.md#why-is-webgui-static-synced-explicitly

// ask the agent for a tarball of one install's own WebGUI folder
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
  res.send(views.webguiSyncPage({ admin: req.admin, servers: serversDb.getAllServers(), ...flash.readFlash(req, res) }));
});

// two path segments deliberately, a bare "/webgui-sync" would be
// shadowed by the earlier POST "/:id" route matching "webgui-sync" as an id
serversRouter.post("/webgui-sync/confirm", express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
    flash.setFlash(res, { error: "Mission agent is not configured." });
    return res.redirect("/admin/servers");
  }
  const server = serversDb.getServerById(Number(req.body.server_id));
  if (!server || !server.dcs_install_path) {
    flash.setFlash(res, { error: "Pick a server that has a DCS install path set." });
    return res.redirect("/admin/servers/webgui-sync");
  }

  // extract into a scratch dir and validate before touching the live
  // webgui-static/ at all, then swap via two fast same-filesystem renames
  // see docs/Why.md#why-must-the-webgui-sync-scratch-dir-be-a-sibling-of-webguiroot
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
      // the rename into place failed, put the old bundle back
      if (hadExisting) await fs.rename(backupDir, webguiRoot);
      throw renameErr;
    }
    if (hadExisting) await fs.rm(backupDir, { recursive: true, force: true });

    webguiIndexTemplate = loadWebguiIndexTemplate(webguiRoot);

    flash.setFlash(res, { notice: `Synced webgui-static/ from "${server.name}"'s DCS install (${server.dcs_install_path}).` });
    res.redirect("/admin/servers/webgui-sync");
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    flash.setFlash(res, { error: `Sync failed: ${err.message}` });
    res.redirect("/admin/servers/webgui-sync");
  }
}));

app.use("/admin/servers", serversRouter);

// section: a/b self-update, site admins only

const updateRouter = express.Router();
updateRouter.use(auth.requireAccountManager);

updateRouter.get("/", (req, res) => {
  res.send(
    views.updatePage({
      admin: req.admin,
      currentVersion: updateCheck.getCurrentVersion(),
      updateState: updateCheck.getUpdateState(),
      ...flash.readFlash(req, res),
    })
  );
});

updateRouter.post("/check", asyncHandler(async (req, res) => {
  try {
    const hasUpdate = await updateCheck.checkForUpdate();
    const updateState = updateCheck.getUpdateState();
    flash.setFlash(res, {
      notice: hasUpdate ? `Checked now: version ${updateState.available_version} is available.` : "Checked now: you're already running the latest version.",
    });
  } catch (err) {
    flash.setFlash(res, { error: `Check failed: ${err.message}` });
  }
  res.redirect("/admin/update");
}));

updateRouter.post("/", (req, res) => {
  // guards against a double-click firing a second applyUpdate() while
  // one is already in flight, see docs/Why.md#why-does-update-state-track-when-an-update-was-triggered
  const cooldownUntil = updateCheck.getUpdateCooldownUntil();
  if (cooldownUntil) {
    flash.setFlash(res, { error: `An update was just started, try again after ${cooldownUntil.toISOString().slice(11, 19)} UTC.` });
    return res.redirect("/admin/update");
  }
  updateCheck.recordUpdateTriggered();
  // respond first, only kick off applyUpdate() once the response has
  // actually finished sending, it ends in process.exit() on success,
  // which must never race the admin's own page load
  res.on("finish", () => {
    updateCheck.applyUpdate().catch((err) => console.error(`Update failed: ${err.message}`));
  });
  flash.setFlash(res, { notice: "Update started. Staging the new release and restarting both services — this can take a minute; refresh afterward." });
  res.redirect("/admin/update");
});

app.use("/admin/update", updateRouter);

// section: site-wide settings, site admins only

const settingsRouter = express.Router();
settingsRouter.use(auth.requireAccountManager);

settingsRouter.get("/", (req, res) => {
  res.send(
    views.settingsPage({
      admin: req.admin,
      pinUpdateNav: settings.getSetting("pin_update_nav") === "1",
      ...flash.readFlash(req, res),
    })
  );
});

settingsRouter.post("/", express.urlencoded({ extended: false }), (req, res) => {
  settings.setSetting("pin_update_nav", req.body.pin_update_nav === "1" ? "1" : "0");
  flash.setFlash(res, { notice: "Settings saved." });
  res.redirect("/admin/settings");
});

app.use("/admin/settings", settingsRouter);

// section: logs, the auth-gate's own plus the mission-agent's, merged
// site admins only

const logsRouter = express.Router();
logsRouter.use(auth.requireAccountManager);

const LOG_WINDOWS_MS = { "15m": 15 * 60 * 1000, "1h": 60 * 60 * 1000, "6h": 6 * 60 * 60 * 1000, "24h": 24 * 60 * 60 * 1000 };

// parse a raw ndjson log file's text into entry objects
function parseLogLines(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.t === "string" && typeof parsed.msg === "string") return parsed;
      } catch {
        // fall through to the raw case below
      }
      return { t: null, level: "raw", msg: line };
    });
}

// fetch and parse the mission-agent's own log entries
async function fetchAgentLogEntries() {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) throw new Error("Mission agent is not configured.");
  const url = new URL("/logs", MISSION_AGENT_URL);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` } });
  if (!res.ok) throw new Error(`agent returned ${res.status}`);
  return parseLogLines(await res.text());
}

logsRouter.get("/", asyncHandler(async (req, res) => {
  const requested = Array.isArray(req.query.source) ? req.query.source : req.query.source ? [req.query.source] : ["app", "agent"];
  const sources = new Set(requested.filter((s) => s === "app" || s === "agent"));
  if (sources.size === 0) {
    sources.add("app");
    sources.add("agent");
  }
  // Object.hasOwn, not `in`, so ?since=constructor can't walk the
  // prototype chain to a function and silently turn the cutoff into NaN
  const since = typeof req.query.since === "string" && Object.hasOwn(LOG_WINDOWS_MS, req.query.since) ? req.query.since : "all";
  const verbose = req.query.verbose === "1";

  let entries = [];
  if (sources.has("app")) {
    entries = entries.concat(appLog.readRecentEntries(1000).map((e) => ({ ...e, source: "app" })));
  }
  let agentError = null;
  if (sources.has("agent")) {
    try {
      entries = entries.concat((await fetchAgentLogEntries()).map((e) => ({ ...e, source: "agent" })));
    } catch (err) {
      agentError = `Could not reach the mission agent: ${err.message}`;
    }
  }

  entries.sort((a, b) => (a.t || "").localeCompare(b.t || ""));
  if (!verbose) entries = entries.filter((e) => e.level !== "debug");
  if (since !== "all") {
    const cutoff = Date.now() - LOG_WINDOWS_MS[since];
    entries = entries.filter((e) => e.t && new Date(e.t).getTime() >= cutoff);
  }
  entries = entries.slice(-300);

  res.send(views.logsPage({ admin: req.admin, entries, agentError, filters: { sources, since, verbose } }));
}));

app.use("/admin/logs", logsRouter);

// section: per-server access check, mission upload, then generic proxy

// permission is one of servers.js's PERMISSION_COLUMNS keys, or
// omitted for routes that only need some access to the server at all
function requireServerAccess({ permission } = {}) {
  return (req, res, next) => {
    const server = serversDb.getServerBySlug(req.params.slug);
    if (!server) return res.status(404).send("Unknown server.");
    if (!serversDb.hasPermission(req.admin.id, server.id, permission || "access")) {
      return res.status(403).send("Forbidden: you don't have access to this server.");
    }
    req.dcsServer = server;
    next();
  };
}

// missions arrive in memory, only .miz files accepted
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    cb(null, file.originalname.toLowerCase().endsWith(".miz"));
  },
});

// this admin's own mission permissions on this one server
function loadMissionAccess(req) {
  const access = serversDb.getAccess(req.admin.id, req.dcsServer.id) || {};
  return {
    canUpload: Boolean(access.can_upload_missions),
    canView: Boolean(access.can_view_missions),
    canDownload: Boolean(access.can_download_missions),
    canDelete: Boolean(access.can_delete_missions),
  };
}

// ask the agent for one instance's mission list
async function fetchMissionsList(instanceName) {
  const url = new URL(`/missions/${encodeURIComponent(instanceName)}`, MISSION_AGENT_URL);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` } });
  if (!res.ok) throw new Error(`agent returned ${res.status}`);
  return (await res.json()).missions;
}

// render the missions page, loading the list only if this admin can view it
async function renderMissionsPage(req, res, { status = 200, error, notice } = {}) {
  const access = loadMissionAccess(req);
  let missions = [];
  let pageError = error;
  // the list is also needed to pick a mission for download/delete,
  // not shown only to admins with the view flag itself
  if (access.canView || access.canDownload || access.canDelete) {
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
      pageError = pageError || "Mission agent is not configured.";
    } else {
      try {
        missions = await fetchMissionsList(req.dcsServer.instance_name);
      } catch (err) {
        pageError = pageError || `Could not reach the mission agent: ${err.message}`;
      }
    }
  }
  res.status(status).send(views.missionsPage({ admin: req.admin, server: req.dcsServer, access, missions, error: pageError, notice }));
}

app.get("/s/:slug/missions", requireServerAccess({ permission: "any-mission" }), (req, res) => {
  renderMissionsPage(req, res, flash.readFlash(req, res));
});

// redirects after every outcome so reloading the result page never
// resubmits the same file, unlike download/trash below (download
// streams a file directly, a reloaded trash request is just harmless)
app.post(
  "/s/:slug/missions/upload",
  requireServerAccess({ permission: "upload" }),
  (req, res, next) => {
    upload.single("mission")(req, res, (err) => {
      if (err) {
        flash.setFlash(res, { error: err.message });
        return res.redirect(`/s/${encodeURIComponent(req.params.slug)}/missions`);
      }
      next();
    });
  },
  asyncHandler(async (req, res) => {
    const missionsUrl = `/s/${encodeURIComponent(req.params.slug)}/missions`;
    if (!req.file) {
      flash.setFlash(res, { error: "No .miz file provided." });
      return res.redirect(missionsUrl);
    }
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) {
      flash.setFlash(res, { error: "Mission agent is not configured." });
      return res.redirect(missionsUrl);
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
        flash.setFlash(res, { error: `Mission agent rejected the upload: ${detail || agentRes.status}` });
        return res.redirect(missionsUrl);
      }
    } catch (err) {
      flash.setFlash(res, { error: `Could not reach the mission agent: ${err.message}` });
      return res.redirect(missionsUrl);
    }
    flash.setFlash(res, { notice: `Uploaded ${req.file.originalname}.` });
    res.redirect(missionsUrl);
  })
);

app.post(
  "/s/:slug/missions/download",
  requireServerAccess({ permission: "download" }),
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const names = [].concat(req.body?.mission || []);
    if (names.length === 0) return renderMissionsPage(req, res, { status: 400, error: "No missions selected." });
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) return renderMissionsPage(req, res, { status: 500, error: "Mission agent is not configured." });
    try {
      const agentRes = await fetch(new URL(`/missions/${encodeURIComponent(req.dcsServer.instance_name)}/download`, MISSION_AGENT_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ missions: names }),
      });
      if (!agentRes.ok) {
        const detail = await agentRes.text().catch(() => "");
        return renderMissionsPage(req, res, { status: 502, error: `Mission agent rejected the download: ${detail || agentRes.status}` });
      }
      const disposition = agentRes.headers.get("content-disposition");
      res.set("Content-Type", agentRes.headers.get("content-type") || "application/zip");
      if (disposition) res.set("Content-Disposition", disposition);
      await pipeline(Readable.fromWeb(agentRes.body), res);
    } catch (err) {
      if (!res.headersSent) return renderMissionsPage(req, res, { status: 502, error: `Could not reach the mission agent: ${err.message}` });
      res.end();
    }
  })
);

app.post(
  "/s/:slug/missions/trash",
  requireServerAccess({ permission: "delete" }),
  express.urlencoded({ extended: false }),
  asyncHandler(async (req, res) => {
    const names = [].concat(req.body?.mission || []);
    if (names.length === 0) return renderMissionsPage(req, res, { status: 400, error: "No missions selected." });
    if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) return renderMissionsPage(req, res, { status: 500, error: "Mission agent is not configured." });
    try {
      const agentRes = await fetch(new URL(`/missions/${encodeURIComponent(req.dcsServer.instance_name)}/trash`, MISSION_AGENT_URL), {
        method: "POST",
        headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ missions: names }),
      });
      if (!agentRes.ok) {
        const detail = await agentRes.text().catch(() => "");
        return renderMissionsPage(req, res, { status: 502, error: `Mission agent rejected the delete: ${detail || agentRes.status}` });
      }
    } catch (err) {
      return renderMissionsPage(req, res, { status: 502, error: `Could not reach the mission agent: ${err.message}` });
    }
    renderMissionsPage(req, res, { notice: names.length === 1 ? `Moved "${names[0]}" to trash.` : `Moved ${names.length} missions to trash.` });
  })
);

// section: the real dcs webgui itself, reverse-proxied and rewritten
// see docs/Why.md#why-does-the-auth-gate-rewrite-fetch-instead-of-a-plain-reverse-proxy

// gitignored, each deployment supplies its own legitimate copy
// see docs/Why.md#why-is-webgui-static-gitignored-instead-of-shipped
const webguiRoot = process.env.WEBGUI_STATIC_PATH || path.join(__dirname, "..", "webgui-static");

// matches the app.js script tag regardless of quoting/whitespace
// see docs/Why.md#why-does-the-bootstrap-injection-match-the-script-tag-with-a-regex
const APP_JS_SCRIPT_RE = /<script\s+src=["']?js\/app\.js["']?\s*>\s*<\/script>/;

// read index.html and warn (never throw) if it's missing or unexpected
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

app.get("/s/:slug/", requireServerAccess(), (req, res) => {
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
        // undo one specific escape before parsing
        // see docs/Why.md#why-does-the-backend-url-rewrite-undo-a-literal-backslash
        target = new URL(url.replace(/\\\\+:(\\d+)/, ":$1"), location.href);
      } catch (e) {
        return null;
      }
      // the app's own served files, under base_path, stay untouched
      // everything else is the app trying to reach its live backend
      if (target.hostname === location.hostname && target.pathname.indexOf(BASE_PATH) === 0) return null;
      target.protocol = location.protocol;
      target.hostname = location.hostname;
      target.port = CONTROL_PORT;
      return target.toString();
    }
    // fakes the real webgui's own control-port discovery response
    // see docs/Why.md#why-does-the-bootstrap-fake-the-control-port-discovery-call
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

  // adds a link back to this app's own dashboard
  // see docs/Why.md#why-is-the-back-button-anchored-to-the-navbar-brand
  (function () {
    var STYLE_ID = "auth-gate-back-btn-style";
    if (!document.getElementById(STYLE_ID)) {
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        ".auth-gate-back-btn:hover { opacity: 1; color: #fff; border-left-color: #0d79e5; }";
      document.head.appendChild(style);
    }

    function placeButton(brandEl) {
      var navbarEl = brandEl.closest(".navbar") || brandEl.parentElement;
      var btn = document.createElement("a");
      btn.className = "auth-gate-back-btn";
      btn.href = "/";
      btn.textContent = "\\u2190 Control Panel";
      // styled as a nav item, the same idiom the real sidebar's own
      // links use, not a floating pill that reads as a foreign widget
      btn.style.cssText =
        "position:absolute;top:50%;transform:translateY(-50%);" +
        "padding:12px 16px;border-left:3px solid transparent;" +
        "color:#c3c3c3;opacity:.75;" +
        "font:1.1em/13px OpenSansRegular,Arial,sans-serif;text-decoration:none;" +
        "white-space:nowrap;z-index:2147483647;" +
        "transition:opacity .15s ease-in-out,color .15s ease-in-out,border-color .15s ease-in-out;";
      navbarEl.appendChild(btn);

      function reposition() {
        var navRect = navbarEl.getBoundingClientRect();
        var brandRect = brandEl.getBoundingClientRect();
        btn.style.left = brandRect.right - navRect.left + 8 + "px";
      }
      reposition();
      window.addEventListener("resize", reposition);
    }

    var existingBrand = document.querySelector(".navbar-brand");
    if (existingBrand) {
      placeButton(existingBrand);
    } else {
      var observer = new MutationObserver(function () {
        var brand = document.querySelector(".navbar-brand");
        if (brand) {
          observer.disconnect();
          placeButton(brand);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
  })();
</script>`;
  res.set("Content-Type", "text/html");
  res.send(webguiIndexTemplate.replace(APP_JS_SCRIPT_RE, `${bootstrap}\n  <script src="js/app.js"></script>`));
});

app.use("/s/:slug", requireServerAccess(), express.static(webguiRoot, { index: false }));

app.use((req, res) => res.status(404).send("Not found."));

// catches whatever asyncHandler forwarded, or any other next(err) call;
// must be registered last, after every route and the 404 above
// see docs/Why.md#why-does-every-async-handler-need-asynchandler
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}: ${err.message}`);
  if (res.headersSent) return res.end();
  res.status(500).send("Internal server error.");
});

// logs a crash that reached neither asyncHandler nor the error
// middleware above, then exits; no graceful close attempted
// see docs/Why.md#why-does-the-crash-handler-exit-immediately-with-no-graceful-close
function logFatalAndExit(kind, reasonOrError) {
  const err = reasonOrError instanceof Error ? reasonOrError : null;
  console.error(`Fatal ${kind}: ${err ? err.message : util.inspect(reasonOrError)}`);
  console.debug(
    `Fatal ${kind} detail: ${util.inspect({
      stack: err ? err.stack : util.inspect(reasonOrError),
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      version: process.version,
    })}`
  );
  process.exit(1);
}

// start every listener this app owns, and wire up a graceful shutdown
function start() {
  const httpServer = app.listen(PORT, () => {
    console.log(`dcs-webgui-auth-gate listening on :${PORT}`);
  });
  const controlProxyServer = serverProxy.startControlProxy();
  updateCheck.startHourlyCheck();
  // explicit db.close() on shutdown
  // see docs/Why.md#why-does-shutdown-call-db-close-explicitly
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
  process.on("unhandledRejection", (reason) => logFatalAndExit("unhandledRejection", reason));
  process.on("uncaughtException", (err) => logFatalAndExit("uncaughtException", err));
}

// only true for `node src/server.js` directly, launcher.js requires
// this file instead of running it, and calls start() explicitly itself
if (require.main === module) {
  start();
}

// expose the express app itself, plus the starter launcher.js calls
module.exports = app;
module.exports.start = start;
