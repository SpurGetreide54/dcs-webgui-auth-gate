// node's crypto, bcrypt for passwords, and the db
const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const BCRYPT_COST = 12;
// 12h sliding idle timeout
const SESSION_TTL_SECONDS = 12 * 60 * 60;
// how much of that 12h can pass before the browser's own cookie
// (set once, at login) needs reissuing to match the slide below
const COOKIE_REFRESH_THRESHOLD_SECONDS = 60 * 60;
const SESSION_COOKIE = "dcs_session";
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
// bounds total attempts from one ip across any number of usernames
// see docs/Why.md#why-is-there-a-separate-per-ip-login-throttle
const RATE_LIMIT_IP_MAX_ATTEMPTS = 20;
// the one place this rule is defined; server.js and views.js both read it
const MIN_PASSWORD_LENGTH = 12;
// bcryptjs 2.x only looks at the first 72 bytes of its input, see
// docs/Why.md#why-does-validatenewpassword-reject-passwords-over-72-bytes
const MAX_PASSWORD_BYTES = 72;

// every expiry/window check below compares against sqlite's own
// datetime('now'), never a js Date, see docs/Why.md#why-does-every-expiry-use-sqlites-own-datetime-instead-of-js-date

// hash a plain password for storage
function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

// the one place the minimum-length rule is checked, shared by every
// handler that accepts a new password; returns the error message, or
// null if the password is acceptable
function validateNewPassword(password) {
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  // bcrypt silently ignores anything past 72 bytes, see
  // docs/Why.md#why-does-validatenewpassword-reject-passwords-over-72-bytes
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes (${byteLength} bytes given); multibyte characters count for more than one byte each.`;
  }
  return null;
}

// check a plain password against a stored hash
// see docs/Why.md#why-is-verifypassword-async-but-hashpassword-isnt
function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// a hash of no real password, compared on login when the username doesn't exist
// see docs/Why.md#why-is-verifypassword-async-but-hashpassword-isnt
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString("hex"), BCRYPT_COST);

// hash a bearer token for storage, so the plain token never sits in the db
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// build the rate-limit bucket key for one ip and username pair
// purpose keeps separate rate-limit buckets under one shared table,
// see docs/Why.md#why-does-change-password-use-a-separate-rate-limit-bucket-from-login
function rateLimitKey(req, username, purpose = "login") {
  return `${purpose}:${req.ip}:${username.toLowerCase()}`;
}

// true once this ip/username pair has hit too many attempts recently
function isRateLimited(req, username, purpose = "login") {
  const key = rateLimitKey(req, username, purpose);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE key = ? AND attempted_at > datetime('now', '-' || ? || ' seconds')`
    )
    .get(key, RATE_LIMIT_WINDOW_SECONDS);
  return row.n >= RATE_LIMIT_MAX_ATTEMPTS;
}

// record one login attempt against this ip and username pair
function recordLoginAttempt(req, username, purpose = "login") {
  db.prepare("INSERT INTO login_attempts (key) VALUES (?)").run(rateLimitKey(req, username, purpose));
}

// build the rate-limit bucket key for one ip alone, no username, so
// it bounds a spray across many usernames, see
// docs/Why.md#why-is-there-a-separate-per-ip-login-throttle
function ipRateLimitKey(req) {
  return `login-ip:${req.ip}`;
}

// true once this ip alone has hit too many attempts recently,
// across any number of usernames
function isIpRateLimited(req) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE key = ? AND attempted_at > datetime('now', '-' || ? || ' seconds')`
    )
    .get(ipRateLimitKey(req), RATE_LIMIT_WINDOW_SECONDS);
  return row.n >= RATE_LIMIT_IP_MAX_ATTEMPTS;
}

// record one login attempt against this ip alone; never cleared on a
// success, unlike the per-username bucket, since this bucket exists
// specifically to bound a spray across many usernames
function recordIpLoginAttempt(req) {
  db.prepare("INSERT INTO login_attempts (key) VALUES (?)").run(ipRateLimitKey(req));
}

// delete attempts outside the window, called opportunistically on login
function pruneOldLoginAttempts() {
  db.prepare(
    `DELETE FROM login_attempts WHERE attempted_at <= datetime('now', '-' || ? || ' seconds')`
  ).run(RATE_LIMIT_WINDOW_SECONDS);
}

// clear this ip/username pair's recorded login attempts
function clearLoginAttempts(req, username, purpose = "login") {
  db.prepare("DELETE FROM login_attempts WHERE key = ?").run(rateLimitKey(req, username, purpose));
}

// delete expired session rows, called opportunistically on login,
// mirrors pruneOldLoginAttempts's own pattern
function pruneExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now')`).run();
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
// see docs/Why.md#why-does-getsessionadmin-report-a-cookie-refresh-flag
function getSessionAdmin(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT admins.*,
         sessions.expires_at < datetime('now', '+' || ? || ' seconds') AS needs_cookie_refresh
       FROM sessions
       JOIN admins ON admins.id = sessions.admin_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > datetime('now')`
    )
    .get(SESSION_TTL_SECONDS - COOKIE_REFRESH_THRESHOLD_SECONDS, tokenHash);
  if (!row) return null;
  const needsCookieRefresh = !!row.needs_cookie_refresh;
  delete row.needs_cookie_refresh;

  // sliding expiry, but only touch the session row once it's within
  // the same cookie-refresh window the caller already checks, instead
  // of writing on every authenticated request
  if (needsCookieRefresh) {
    db.prepare(
      `UPDATE sessions SET expires_at = datetime('now', '+' || ? || ' seconds') WHERE token_hash = ?`
    ).run(SESSION_TTL_SECONDS, tokenHash);
  }

  return { admin: row, needsCookieRefresh };
}

// true if a session with this token hash still exists and hasn't
// expired, read-only: no join, no sliding-expiry update, unlike
// getSessionAdmin, since callers here only need a liveness check
function isSessionHashLive(tokenHash) {
  const row = db.prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')").get(tokenHash);
  return !!row;
}

// delete a session outright, e.g. on logout
function destroySession(token) {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

// express middleware factory: require a valid session, or send the
// caller to login; onCookieRefreshNeeded(res, token) reissues the cookie
// see docs/Why.md#why-does-getsessionadmin-report-a-cookie-refresh-flag
function requireAuth(onCookieRefreshNeeded) {
  return function (req, res, next) {
    const token = req.cookies[SESSION_COOKIE];
    const session = getSessionAdmin(token);
    if (!session) {
      // tell a real page load apart from the spa's own fetch() calls
      // see docs/Why.md#why-does-requireauth-check-sec-fetch-dest
      const isPageLoad = (req.get("sec-fetch-dest") || "document") === "document";
      if (!isPageLoad) {
        return res.status(401).json({ error: "not authenticated" });
      }
      return res.redirect("/login");
    }
    req.admin = session.admin;
    if (session.needsCookieRefresh) onCookieRefreshNeeded(res, token);
    next();
  };
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
  SESSION_TTL_SECONDS,
  DUMMY_PASSWORD_HASH,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  hashPassword,
  verifyPassword,
  validateNewPassword,
  hashToken,
  isRateLimited,
  recordLoginAttempt,
  isIpRateLimited,
  recordIpLoginAttempt,
  pruneOldLoginAttempts,
  clearLoginAttempts,
  pruneExpiredSessions,
  createSession,
  getSessionAdmin,
  isSessionHashLive,
  destroySession,
  requireAuth,
  requireAccountManager,
};
