const db = require("./db");

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
      `SELECT servers.*, admin_server_access.server_id, admin_server_access.can_upload_missions
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

function setAccess(adminId, serverId, { canUploadMissions: canUpload }) {
  db.prepare(
    `INSERT INTO admin_server_access (admin_id, server_id, can_upload_missions)
     VALUES (?, ?, ?)
     ON CONFLICT (admin_id, server_id) DO UPDATE SET can_upload_missions = excluded.can_upload_missions`
  ).run(adminId, serverId, canUpload ? 1 : 0);
}

function revokeAccess(adminId, serverId) {
  db.prepare("DELETE FROM admin_server_access WHERE admin_id = ? AND server_id = ?").run(adminId, serverId);
}

function grantAllServers(adminId, { canUploadMissions: canUpload }) {
  const all = getAllServers();
  for (const server of all) {
    setAccess(adminId, server.id, { canUploadMissions: canUpload });
  }
}

module.exports = {
  getServerBySlug,
  getServerById,
  getAllServers,
  getAccessibleServers,
  getAccess,
  hasServerAccess,
  canUploadMissions,
  setAccess,
  revokeAccess,
  grantAllServers,
};
