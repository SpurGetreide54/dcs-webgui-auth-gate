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
      // see docs/Why.md#why-does-getaccessibleservers-select-server-id-explicitly
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

// true if this admin can upload missions to this server specifically
function canUploadMissions(adminId, serverId) {
  const access = getAccess(adminId, serverId);
  return Boolean(access && access.can_upload_missions);
}

// true if this admin holds the named permission on this server
function hasPermission(adminId, serverId, permission) {
  const access = getAccess(adminId, serverId);
  if (!access) return false;
  if (permission === "access") return true;
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

// remove an admin's access row for one server entirely
function revokeAccess(adminId, serverId) {
  db.prepare("DELETE FROM admin_server_access WHERE admin_id = ? AND server_id = ?").run(adminId, serverId);
}

// make sure an access row exists for this admin and server, all flags off
function ensureAccessRow(adminId, serverId) {
  db.prepare(
    `INSERT INTO admin_server_access (admin_id, server_id) VALUES (?, ?)
     ON CONFLICT (admin_id, server_id) DO NOTHING`
  ).run(adminId, serverId);
}

// toggle exactly one permission cell, leaving every other column alone
// see docs/Why.md#why-are-there-two-ways-to-set-an-admins-permissions
function setPermission(adminId, serverId, permission, granted) {
  // "access" itself has no column, it's the row's own existence
  if (permission === "access") {
    if (granted) return ensureAccessRow(adminId, serverId);
    return revokeAccess(adminId, serverId);
  }
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  ensureAccessRow(adminId, serverId);
  db.prepare(`UPDATE admin_server_access SET ${column} = ? WHERE admin_id = ? AND server_id = ?`).run(granted ? 1 : 0, adminId, serverId);
}

// grant the same permission set to this admin on every server at once
function grantAllServers(adminId, grants) {
  for (const server of getAllServers()) {
    setAccess(adminId, server.id, grants);
  }
}

// expose the lookup table and every function above to callers
module.exports = {
  PERMISSION_COLUMNS,
  getServerBySlug,
  getServerById,
  getAllServers,
  getAccessibleServers,
  getAccess,
  hasServerAccess,
  canUploadMissions,
  hasPermission,
  setAccess,
  setPermission,
  revokeAccess,
  grantAllServers,
};
