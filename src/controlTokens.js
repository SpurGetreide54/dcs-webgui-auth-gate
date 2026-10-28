// node's own crypto module, for random token bytes
const crypto = require("node:crypto");

// short-lived token standing in for the session cookie on control-port
// requests, minted on page load, checked by serverProxy.js
// see docs/Why.md#why-do-control-port-requests-use-a-separate-token
const TOKEN_TTL_MS = 5 * 60 * 1000;
// the sliding window's own hard ceiling, even if something keeps
// polling with this token forever
// see docs/Why.md#why-does-a-control-tokens-expiry-slide-forward
const MAX_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;
// all live tokens, keyed by the token string itself
const tokens = new Map();

// drop every token whose window has already closed
function pruneExpired() {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}

// create and store a fresh token for this admin and server
function mint(adminId, serverId) {
  pruneExpired();
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  tokens.set(token, { adminId, serverId, mintedAt: now, expiresAt: now + TOKEN_TTL_MS });
  return token;
}

// look up a token, dropping and refusing it once its window has closed
function resolve(token) {
  const entry = tokens.get(token);
  if (!entry) return null;
  const now = Date.now();
  if (entry.expiresAt < now) {
    tokens.delete(token);
    return null;
  }
  // slide the window forward, capped at the token's own max lifetime
  entry.expiresAt = Math.min(now + TOKEN_TTL_MS, entry.mintedAt + MAX_TOKEN_LIFETIME_MS);
  return entry;
}

// expose both functions to callers
module.exports = { mint, resolve };
