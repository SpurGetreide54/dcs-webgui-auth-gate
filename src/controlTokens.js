const crypto = require("node:crypto");

// The real DCS webgui reaches its backend via fetch() to a swapped
// hostname:port origin, not a path under the page that loaded it. The
// browser's default same-origin credentials mode never attaches the
// session cookie to that request. These short-lived tokens are the
// substitute. Minted server-side when an authorized admin loads
// /s/<slug>/, injected into that page's own fetch() calls (see
// server.js), and checked by the control-port proxy (serverProxy.js) in
// place of a cookie.
// A token slides forward on every use instead of expiring on a one-shot
// clock: the real DCS webgui polls its own backend every 2 seconds on its
// own (see webgui-static/js/app.js's lifecycleTick), so an admin who just
// leaves a server's control panel open -- the normal way to use this app
// -- keeps it alive indefinitely, instead of losing control after a flat
// 5 minutes with no visible error. TOKEN_TTL_MS is that sliding renewal
// window. MAX_TOKEN_LIFETIME_MS still bounds it: a leaked or forgotten
// token can't stay useful forever just because something keeps polling
// it. Hitting the ceiling just means the next page load mints a fresh
// one, same as any other page load already does. This doesn't weaken
// what the token protects either way -- serverProxy.js re-checks live DB
// access on every single proxied request, independent of token freshness.
const TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
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
  const now = Date.now();
  tokens.set(token, { adminId, serverId, mintedAt: now, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

function resolve(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt < now) {
    tokens.delete(token);
    return null;
  }
  entry.expiresAt = Math.min(now + TOKEN_TTL_MS, entry.mintedAt + MAX_TOKEN_LIFETIME_MS);
  return entry;
}

module.exports = { mint, resolve };
