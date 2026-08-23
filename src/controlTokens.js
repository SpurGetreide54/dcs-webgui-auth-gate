const crypto = require("node:crypto");

// The real DCS webgui reaches its backend via fetch() to a swapped
// hostname:port origin, not a path under the page that loaded it. The
// browser's default same-origin credentials mode never attaches the
// session cookie to that request. These short-lived tokens are the
// substitute. Minted server-side when an authorized admin loads
// /s/<slug>/, injected into that page's own fetch() calls (see
// server.js), and checked by the control-port proxy (serverProxy.js) in
// place of a cookie.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokens = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}

function mint(adminId, serverId) {
  pruneExpired();
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, { adminId, serverId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

function resolve(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

module.exports = { mint, resolve };
