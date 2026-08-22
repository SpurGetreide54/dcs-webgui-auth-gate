const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const BCRYPT_COST = 12;
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h sliding idle timeout
const SESSION_COOKIE = "dcs_session";
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function rateLimitKey(req, username) {
  return `${req.ip}:${username.toLowerCase()}`;
}

// All expiry/window arithmetic happens inside SQLite via datetime('now', ...)
// rather than JS Date/toISOString(): comparing a JS ISO string ("...T...Z")
// against SQLite's own datetime('now') format ("YYYY-MM-DD HH:MM:SS") is a
// plain string comparison, and the two formats sort inconsistently at the
// same instant — it happened to look fine for 12h session expiry (the date
// part alone usually differs) but silently broke the 15-minute rate-limit
// window, where same-day comparisons actually depend on the mismatched
// 'T'/space byte. Keeping every timestamp in SQLite's own format sidesteps
// the mismatch entirely.

function isRateLimited(req, username) {
  const key = rateLimitKey(req, username);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE key = ? AND attempted_at > datetime('now', '-' || ? || ' seconds')`
    )
    .get(key, RATE_LIMIT_WINDOW_SECONDS);
  return row.n >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordLoginAttempt(req, username) {
  db.prepare("INSERT INTO login_attempts (key) VALUES (?)").run(rateLimitKey(req, username));
}

// Attempts accumulate forever otherwise; called opportunistically on login.
function pruneOldLoginAttempts() {
  db.prepare(
    `DELETE FROM login_attempts WHERE attempted_at <= datetime('now', '-' || ? || ' seconds')`
  ).run(RATE_LIMIT_WINDOW_SECONDS);
}

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    `INSERT INTO sessions (admin_id, token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+' || ? || ' seconds'))`
  ).run(adminId, hashToken(token), SESSION_TTL_SECONDS);
  return token;
}

function getSessionAdmin(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT admins.* FROM sessions
       JOIN admins ON admins.id = sessions.admin_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`
    )
    .get(hashToken(token));
  if (!row) return null;

  // Sliding expiry: touch the session on every authenticated request.
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+' || ? || ' seconds') WHERE token_hash = ?`
  ).run(SESSION_TTL_SECONDS, hashToken(token));

  return row;
}

function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const admin = getSessionAdmin(token);
  if (!admin) {
    // Sec-Fetch-Dest is set by the browser itself (app.js can't override it),
    // so it reliably tells apart a real page load from the SPA's own fetch()
    // calls to the control-port API — both hit /s/<slug>/... paths.
    // Missing header (curl, very old browsers) defaults to "document": a
    // human hitting the URL directly should see the login page, not raw JSON.
    const isPageLoad = (req.get("sec-fetch-dest") || "document") === "document";
    if (!isPageLoad) {
      return res.status(401).json({ error: "not authenticated" });
    }
    return res.redirect("/login");
  }
  req.admin = admin;
  next();
}

function requireAccountManager(req, res, next) {
  if (!req.admin.can_manage_accounts) {
    return res.status(403).send("Forbidden: account management access required.");
  }
  next();
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  isRateLimited,
  recordLoginAttempt,
  pruneOldLoginAttempts,
  createSession,
  getSessionAdmin,
  destroySession,
  requireAuth,
  requireAccountManager,
};
