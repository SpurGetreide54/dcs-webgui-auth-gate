// node's crypto for random tokens, the db, the auth module's hashing,
// and the shared permission column names
const crypto = require("node:crypto");
const db = require("./db");
const auth = require("./auth");
const { revokeAccessRowOn, ensureAccessRowOn, setPermissionOn } = require("./servers");

const INVITE_TTL_SECONDS = 30 * 60;

// delete every invite whose window has already closed
// called opportunistically, same pattern as auth.pruneOldLoginAttempts
function pruneExpired() {
  db.prepare("DELETE FROM invites WHERE expires_at <= datetime('now')").run();
}

// create a new invite, returning its row id and the plain token
function createInvite({ canManageAccounts }) {
  // only the hash is stored, the plain token is handed back once
  const token = crypto.randomBytes(32).toString("hex");
  const info = db
    .prepare(
      `INSERT INTO invites (token_hash, token_prefix, can_manage_accounts, expires_at)
       VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))`
    )
    .run(auth.hashToken(token), token.slice(0, 6), canManageAccounts ? 1 : 0, INVITE_TTL_SECONDS);
  return { id: info.lastInsertRowid, token };
}

// remove an invite's access row for one server entirely
function revokeInviteAccess(inviteId, serverId) {
  revokeAccessRowOn("invite_server_access", "invite_id", inviteId, serverId);
}

// make sure an access row exists for this invite and server, all flags off
function ensureInviteAccessRow(inviteId, serverId) {
  ensureAccessRowOn("invite_server_access", "invite_id", inviteId, serverId);
}

// toggle one permission cell for a pending invite
// mirrors servers.js's own setPermission, through the same shared helper
function setInvitePermission(inviteId, serverId, permission, granted) {
  return setPermissionOn("invite_server_access", "invite_id", inviteId, serverId, permission, granted);
}

// list every server an invite has an access row for
function getInviteAccess(inviteId) {
  return db.prepare("SELECT * FROM invite_server_access WHERE invite_id = ?").all(inviteId);
}

// same lookup as getInviteAccess, but for every invite id at once;
// used by listValidInvites to avoid one query per invite
function getInviteAccessBatch(inviteIds) {
  if (inviteIds.length === 0) return new Map();
  const placeholders = inviteIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM invite_server_access WHERE invite_id IN (${placeholders})`)
    .all(...inviteIds);
  const byInvite = new Map(inviteIds.map((id) => [id, []]));
  for (const row of rows) byInvite.get(row.invite_id).push(row);
  return byInvite;
}

// list every invite that hasn't expired yet, with its access rows attached
function listValidInvites() {
  const invites = db.prepare("SELECT * FROM invites WHERE expires_at > datetime('now') ORDER BY id").all();
  const accessByInvite = getInviteAccessBatch(invites.map((invite) => invite.id));
  return invites.map((invite) => ({ ...invite, access: accessByInvite.get(invite.id) }));
}

// look up a still-valid invite by its row id
function getValidInviteById(id) {
  return db.prepare("SELECT * FROM invites WHERE id = ? AND expires_at > datetime('now')").get(id);
}

// look up a still-valid invite by its plain token, hashed before lookup
function getValidInviteByToken(token) {
  return db
    .prepare("SELECT * FROM invites WHERE token_hash = ? AND expires_at > datetime('now')")
    .get(auth.hashToken(token));
}

// flip whether accepting this invite also grants account management
function setCanManageAccounts(inviteId, canManageAccounts) {
  db.prepare("UPDATE invites SET can_manage_accounts = ? WHERE id = ?").run(canManageAccounts ? 1 : 0, inviteId);
}

// delete an invite outright, regardless of whether it's expired
function deleteInvite(id) {
  db.prepare("DELETE FROM invites WHERE id = ?").run(id);
}

// expose every function above, plus the ttl constant, to callers
module.exports = {
  INVITE_TTL_SECONDS,
  pruneExpired,
  createInvite,
  setInvitePermission,
  revokeInviteAccess,
  getInviteAccess,
  getInviteAccessBatch,
  listValidInvites,
  getValidInviteById,
  getValidInviteByToken,
  setCanManageAccounts,
  deleteInvite,
};
