// node's crypto, bcrypt for passwords, and the db
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const BCRYPT_COST = 12;
// 12h sliding idle timeout
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const SESSION_COOKIE = "dcs_session";
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

// every expiry/window check below compares against sqlite's own
// datetime('now'), never a js Date, see docs/Why.md#why-does-every-expiry-use-sqlites-own-datetime

// hash a plain password for storage
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

// check a plain password against a stored hash
function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// hash a bearer token for storage, so the plain token never sits in the db
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// build the rate-limit bucket key for one ip and username pair
function rateLimitKey(req, username) {
  return `${req.ip}:${username.toLowerCase()}`;
}

// true once this ip/username pair has hit too many attempts recently
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

// record one login attempt against this ip and username pair
function recordLoginAttempt(req, username) {
  db.prepare("INSERT INTO login_attempts (key) VALUES (?)").run(rateLimitKey(req, username));
}

// delete attempts outside the window, called opportunistically on login
function pruneOldLoginAttempts() {
  db.prepare(
    `DELETE FROM login_attempts WHERE attempted_at <= datetime('now', '-' || ? || ' seconds')`
  ).run(RATE_LIMIT_WINDOW_SECONDS);
}

// create a new session for this admin, returning its plain token
function createSession(adminId) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare(
    `INSERT INTO sessions (admin_id, token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+' || ? || ' seconds'))`
  ).run(adminId, hashToken(token), SESSION_TTL_SECONDS);
  return token;
}

// look up the admin a session token belongs to, or null if it's gone
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

  // sliding expiry, touch the session on every authenticated request
  db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', '+' || ? || ' seconds') WHERE token_hash = ?`
  ).run(SESSION_TTL_SECONDS, hashToken(token));

  return row;
}

// delete a session outright, e.g. on logout
function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

// express middleware: require a valid session, or send the caller to login
function requireAuth(req, res, next) {
  const token = req.cookies[SESSION_COOKIE];
  const admin = getSessionAdmin(token);
  if (!admin) {
    // tell a real page load apart from the spa's own fetch() calls
    // see docs/Why.md#why-does-requireauth-check-sec-fetch-dest
    const isPageLoad = (req.get("sec-fetch-dest") || "document") === "document";
    if (!isPageLoad) {
      return res.status(401).json({ error: "not authenticated" });
    }
    return res.redirect("/login");
  }
  req.admin = admin;
  next();
}

// express middleware: require the logged-in admin to manage accounts
function requireAccountManager(req, res, next) {
  if (!req.admin.can_manage_accounts) {
    return res.status(403).send("Forbidden: account management access required.");
  }
  next();
}

// expose every public function and the session cookie's own name
module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  hashToken,
  isRateLimited,
  recordLoginAttempt,
  pruneOldLoginAttempts,
  createSession,
  getSessionAdmin,
  destroySession,
  requireAuth,
  requireAccountManager,
};
