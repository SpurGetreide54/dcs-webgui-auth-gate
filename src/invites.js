const crypto = require("node:crypto");
const db = require("./db");
const auth = require("./auth");
const { PERMISSION_COLUMNS } = require("./servers");

const INVITE_TTL_SECONDS = 30 * 60;

// Expired invites accumulate otherwise. Called opportunistically, same
// pattern as auth.pruneOldLoginAttempts.
function pruneExpired() {
  db.prepare("DELETE FROM invites WHERE expires_at <= datetime('now')").run();
}

function createInvite({ canManageAccounts }) {
  const token = crypto.randomBytes(32).toString("hex");
  const info = db
    .prepare(
      `INSERT INTO invites (token_hash, token_prefix, can_manage_accounts, expires_at)
       VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))`
    )
    .run(auth.hashToken(token), token.slice(0, 6), canManageAccounts ? 1 : 0, INVITE_TTL_SECONDS);
  return { id: info.lastInsertRowid, token };
}

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

function revokeInviteAccess(inviteId, serverId) {
  db.prepare("DELETE FROM invite_server_access WHERE invite_id = ? AND server_id = ?").run(inviteId, serverId);
}

function ensureInviteAccessRow(inviteId, serverId) {
  db.prepare(
    `INSERT INTO invite_server_access (invite_id, server_id) VALUES (?, ?)
     ON CONFLICT (invite_id, server_id) DO NOTHING`
  ).run(inviteId, serverId);
}

// Mirrors servers.js's setPermission -- same one-cell-at-a-time toggle,
// for the pending-invite row in the same matrix popup.
function setInvitePermission(inviteId, serverId, permission, granted) {
  if (permission === "access") {
    if (granted) return ensureInviteAccessRow(inviteId, serverId);
    return revokeInviteAccess(inviteId, serverId);
  }
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  ensureInviteAccessRow(inviteId, serverId);
  db.prepare(`UPDATE invite_server_access SET ${column} = ? WHERE invite_id = ? AND server_id = ?`).run(granted ? 1 : 0, inviteId, serverId);
}

function getInviteAccess(inviteId) {
  return db.prepare("SELECT * FROM invite_server_access WHERE invite_id = ?").all(inviteId);
}

function listValidInvites() {
  return db
    .prepare("SELECT * FROM invites WHERE expires_at > datetime('now') ORDER BY id")
    .all()
    .map((invite) => ({ ...invite, access: getInviteAccess(invite.id) }));
}

function getValidInviteById(id) {
  return db.prepare("SELECT * FROM invites WHERE id = ? AND expires_at > datetime('now')").get(id);
}

function getValidInviteByToken(token) {
  return db
    .prepare("SELECT * FROM invites WHERE token_hash = ? AND expires_at > datetime('now')")
    .get(auth.hashToken(token));
}

function setCanManageAccounts(inviteId, canManageAccounts) {
  db.prepare("UPDATE invites SET can_manage_accounts = ? WHERE id = ?").run(canManageAccounts ? 1 : 0, inviteId);
}

function deleteInvite(id) {
  db.prepare("DELETE FROM invites WHERE id = ?").run(id);
}

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
