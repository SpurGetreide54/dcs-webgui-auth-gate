// node's crypto for random tokens, the db, the auth module's hashing,
// and the shared permission column names
const crypto = require("node:crypto");
const db = require("./db");
const auth = require("./auth");
const { PERMISSION_COLUMNS } = require("./servers");

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

// grant (or overwrite) an invite's permissions on one server
function setInviteAccess(inviteId, serverId, grants = {}) {
  const { canUploadMissions = false, canViewMissions = false, canDownloadMissions = false, canDeleteMissions = false } = grants;
  db.prepare(
    `INSERT INTO invite_server_access
       (invite_id, server_id, can_upload_missions, can_view_missions, can_download_missions, can_delete_missions)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (invite_id, server_id) DO UPDATE SET
       can_upload_missions = excluded.can_upload_missions,
       can_view_missions = excluded.can_view_missions,
       can_download_missions = excluded.can_download_missions,
       can_delete_missions = excluded.can_delete_missions`
  ).run(inviteId, serverId, canUploadMissions ? 1 : 0, canViewMissions ? 1 : 0, canDownloadMissions ? 1 : 0, canDeleteMissions ? 1 : 0);
}

// remove an invite's access row for one server entirely
function revokeInviteAccess(inviteId, serverId) {
  db.prepare("DELETE FROM invite_server_access WHERE invite_id = ? AND server_id = ?").run(inviteId, serverId);
}

// make sure an access row exists for this invite and server, all flags off
function ensureInviteAccessRow(inviteId, serverId) {
  db.prepare(
    `INSERT INTO invite_server_access (invite_id, server_id) VALUES (?, ?)
     ON CONFLICT (invite_id, server_id) DO NOTHING`
  ).run(inviteId, serverId);
}

// toggle one permission cell for a pending invite
// mirrors servers.js's setPermission for the same matrix popup
function setInvitePermission(inviteId, serverId, permission, granted) {
  // "access" itself has no column, it's the row's own existence
  if (permission === "access") {
    if (granted) return ensureInviteAccessRow(inviteId, serverId);
    return revokeInviteAccess(inviteId, serverId);
  }
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  ensureInviteAccessRow(inviteId, serverId);
  db.prepare(`UPDATE invite_server_access SET ${column} = ? WHERE invite_id = ? AND server_id = ?`).run(granted ? 1 : 0, inviteId, serverId);
}

// list every server an invite has an access row for
function getInviteAccess(inviteId) {
  return db.prepare("SELECT * FROM invite_server_access WHERE invite_id = ?").all(inviteId);
}

// list every invite that hasn't expired yet, with its access rows attached
function listValidInvites() {
  return db
    .prepare("SELECT * FROM invites WHERE expires_at > datetime('now') ORDER BY id")
    .all()
    .map((invite) => ({ ...invite, access: getInviteAccess(invite.id) }));
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
  setInviteAccess,
  setInvitePermission,
  revokeInviteAccess,
  getInviteAccess,
  listValidInvites,
  getValidInviteById,
  getValidInviteByToken,
  setCanManageAccounts,
  deleteInvite,
};
