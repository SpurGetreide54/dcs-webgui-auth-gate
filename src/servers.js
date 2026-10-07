const db = require("./db");

// "access" isn't a real column -- it's just "the row exists at all". The
// other four map straight onto admin_server_access's own columns. Keeping
// this as the single lookup table means a column name is never built from
// anything other than this fixed set, regardless of what a request handler
// passes through.
const PERMISSION_COLUMNS = {
  upload: "can_upload_missions",
  view: "can_view_missions",
  download: "can_download_missions",
  delete: "can_delete_missions",
};

function getServerBySlug(slug) {
  return db.prepare("SELECT * FROM servers WHERE slug = ?").get(slug);
}

function getServerById(id) {
  return db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
}

function getAllServers() {
  return db.prepare("SELECT * FROM servers ORDER BY id").all();
}

function getAccessibleServers(adminId) {
  return db
    .prepare(
      // servers.* alone gives a bare `id` -- the server's own id -- with no
      // way to tell it apart from an admin_server_access row's id. Callers
      // checking "does this admin have access to server X" via
      // `.server_id` would get `undefined` and never match. Left unfixed,
      // the accounts page renders every checkbox as unchecked, regardless
      // of the real grant.
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

function getAccess(adminId, serverId) {
  return db
    .prepare("SELECT * FROM admin_server_access WHERE admin_id = ? AND server_id = ?")
    .get(adminId, serverId);
}

function hasServerAccess(adminId, serverId) {
  return Boolean(getAccess(adminId, serverId));
}

function canUploadMissions(adminId, serverId) {
  const access = getAccess(adminId, serverId);
  return Boolean(access && access.can_upload_missions);
}

function hasPermission(adminId, serverId, permission) {
  const access = getAccess(adminId, serverId);
  if (!access) return false;
  if (permission === "access") return true;
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  return Boolean(access[column]);
}

// Full replace of a row's permission set -- used only where every flag is
// decided together (initial grant at account/invite creation, the
// bootstrap site admin). Any flag left out of `grants` is explicitly
// cleared, not left alone. The one-cell-at-a-time matrix popup uses
// setPermission below instead, which never touches the other columns.
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

function revokeAccess(adminId, serverId) {
  db.prepare("DELETE FROM admin_server_access WHERE admin_id = ? AND server_id = ?").run(adminId, serverId);
}

function ensureAccessRow(adminId, serverId) {
  db.prepare(
    `INSERT INTO admin_server_access (admin_id, server_id) VALUES (?, ?)
     ON CONFLICT (admin_id, server_id) DO NOTHING`
  ).run(adminId, serverId);
}

// Toggles exactly one permission for one admin+server pair, leaving every
// other column alone -- the matrix popup's per-cell click. "access" with no
// grant removes the whole row (and so every permission with it, same as
// revokeAccess); "access" with a grant creates a bare row if none exists
// yet, defaulting every other permission to 0 rather than guessing.
function setPermission(adminId, serverId, permission, granted) {
  if (permission === "access") {
    if (granted) return ensureAccessRow(adminId, serverId);
    return revokeAccess(adminId, serverId);
  }
  const column = PERMISSION_COLUMNS[permission];
  if (!column) throw new Error(`Unknown permission: ${permission}`);
  ensureAccessRow(adminId, serverId);
  db.prepare(`UPDATE admin_server_access SET ${column} = ? WHERE admin_id = ? AND server_id = ?`).run(granted ? 1 : 0, adminId, serverId);
}

function grantAllServers(adminId, grants) {
  for (const server of getAllServers()) {
    setAccess(adminId, server.id, grants);
  }
}

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
