const db = require("./db");

// the fixed lookup from a permission name to its real column
// "access" isn't a real column, it's just "the row exists at all"
// a column name is never built from anything but this fixed set
const PERMISSION_COLUMNS = {
  upload: "can_upload_missions",
  view: "can_view_missions",
  download: "can_download_missions",
  delete: "can_delete_missions",
};

// look up a server by its url slug
function getServerBySlug(slug) {
  return db.prepare("SELECT * FROM servers WHERE slug = ?").get(slug);
}

// look up a server by its row id
function getServerById(id) {
  return db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
}

// list every configured server
function getAllServers() {
  return db.prepare("SELECT * FROM servers ORDER BY id").all();
}

// list every server this admin has access to, permissions attached
function getAccessibleServers(adminId) {
  return db
    .prepare(
      // server_id is selected explicitly, not left to servers.*'s own id
      // see docs/Why.md#why-does-getaccessibleservers-select-server_id-explicitly
      `SELECT servers.*, admin_server_access.server_id, admin_server_access.can_upload_missions,
              admin_server_access.can_view_missions, admin_server_access.can_download_missions,
              admin_server_access.can_delete_missions
       FROM servers
       JOIN admin_server_access ON admin_server_access.server_id = servers.id
       WHERE admin_server_access.admin_id = ?
       ORDER BY servers.id`
    )
    .all(adminId);
}

// read one admin's raw access row for one server, or undefined
function getAccess(adminId, serverId) {
  return db
    .prepare("SELECT * FROM admin_server_access WHERE admin_id = ? AND server_id = ?")
    .get(adminId, serverId);
}

// true if this admin has any access row at all for this server
function hasServerAccess(adminId, serverId) {
  return Boolean(getAccess(adminId, serverId));
}

// true if this admin holds the named permission; "any-mission" is a
// sentinel for "any of the four mission permissions", not a real column
// see docs/Why.md#why-does-any-mission-exist-alongside-view
function hasPermission(adminId, serverId, permission) {
  const access = getAccess(adminId, serverId);
  if (!access) return false;
  if (permission === "access") return true;
  if (permission === "any-mission") return Object.values(PERMISSION_COLUMNS).some((column) => Boolean(access[column]));
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  return Boolean(access[column]);
}

// replace an admin's whole permission set for one server at once
// see docs/Why.md#why-are-there-two-ways-to-set-an-admins-permissions
function setAccess(adminId, serverId, grants = {}) {
  const { canUploadMissions = false, canViewMissions = false, canDownloadMissions = false, canDeleteMissions = false } = grants;
  db.prepare(
    `INSERT INTO admin_server_access
       (admin_id, server_id, can_upload_missions, can_view_missions, can_download_missions, can_delete_missions)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (admin_id, server_id) DO UPDATE SET
       can_upload_missions = excluded.can_upload_missions,
       can_view_missions = excluded.can_view_missions,
       can_download_missions = excluded.can_download_missions,
       can_delete_missions = excluded.can_delete_missions`
  ).run(adminId, serverId, canUploadMissions ? 1 : 0, canViewMissions ? 1 : 0, canDownloadMissions ? 1 : 0, canDeleteMissions ? 1 : 0);
}

// shared by every table/owner pair below (admin and invite access);
// table and ownerColumn only ever come from this file's own fixed
// call sites, never from request input
function revokeAccessRowOn(table, ownerColumn, ownerId, serverId) {
  db.prepare(`DELETE FROM ${table} WHERE ${ownerColumn} = ? AND server_id = ?`).run(ownerId, serverId);
}

// make sure an access row exists, all flags off; same table/owner
// restriction as revokeAccessRowOn above
function ensureAccessRowOn(table, ownerColumn, ownerId, serverId) {
  db.prepare(`INSERT INTO ${table} (${ownerColumn}, server_id) VALUES (?, ?) ON CONFLICT (${ownerColumn}, server_id) DO NOTHING`).run(
    ownerId,
    serverId
  );
}

// toggle exactly one permission cell, leaving every other column alone;
// shared by setPermission/setInvitePermission below
// see docs/Why.md#why-are-there-two-ways-to-set-an-admins-permissions
function setPermissionOn(table, ownerColumn, ownerId, serverId, permission, granted) {
  // "access" itself has no column, it's the row's own existence
  if (permission === "access") {
    if (granted) return ensureAccessRowOn(table, ownerColumn, ownerId, serverId);
    return revokeAccessRowOn(table, ownerColumn, ownerId, serverId);
  }
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  ensureAccessRowOn(table, ownerColumn, ownerId, serverId);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${ownerColumn} = ? AND server_id = ?`).run(granted ? 1 : 0, ownerId, serverId);
}

// remove an admin's access row for one server entirely
function revokeAccess(adminId, serverId) {
  revokeAccessRowOn("admin_server_access", "admin_id", adminId, serverId);
}

// make sure an access row exists for this admin and server, all flags off
function ensureAccessRow(adminId, serverId) {
  ensureAccessRowOn("admin_server_access", "admin_id", adminId, serverId);
}

// toggle exactly one permission cell, leaving every other column alone
function setPermission(adminId, serverId, permission, granted) {
  return setPermissionOn("admin_server_access", "admin_id", adminId, serverId, permission, granted);
}

// grant the same permission set to this admin on every server at once
function grantAllServers(adminId, grants) {
  for (const server of getAllServers()) {
    setAccess(adminId, server.id, grants);
  }
}

// expose the lookup table and every function above to callers;
// revokeAccessRowOn/ensureAccessRowOn/setPermissionOn are exposed for
// invites.js's own admin_server_access-shaped table, invite_server_access
module.exports = {
  PERMISSION_COLUMNS,
  getServerBySlug,
  getServerById,
  getAllServers,
  getAccessibleServers,
  getAccess,
  hasServerAccess,
  hasPermission,
  setAccess,
  setPermission,
  revokeAccess,
  grantAllServers,
  revokeAccessRowOn,
  ensureAccessRowOn,
  setPermissionOn,
};
