const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// a fresh, unique sqlite path per test file, under the os temp dir
function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `auth-gate-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

// delete a sqlite file and its wal/shm siblings
function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

let db, serversDb, invitesDb;
let sqlitePath;

test.before(() => {
  sqlitePath = tempSqlitePath("batch-queries");
  process.env.SQLITE_PATH = sqlitePath;
  db = require("../src/db");
  serversDb = require("../src/servers");
  invitesDb = require("../src/invites");
});

test.after(() => {
  db.close();
  cleanupSqlite(sqlitePath);
});

test("getAccessibleServersBatch matches looping getAccessibleServers per admin", () => {
  const admin1 = db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, 'x')").run("batch-admin-1").lastInsertRowid;
  const admin2 = db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, 'x')").run("batch-admin-2").lastInsertRowid;
  const server1 = db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES ('b1', 'Server 1', 'i1')").run().lastInsertRowid;
  const server2 = db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES ('b2', 'Server 2', 'i2')").run().lastInsertRowid;

  serversDb.setAccess(admin1, server1, { canViewMissions: true });
  serversDb.setAccess(admin2, server1, { canUploadMissions: true });
  serversDb.setAccess(admin2, server2, { canDeleteMissions: true });

  // the batch rows carry an extra admin_id column (needed to group by),
  // which getAccessibleServers's own per-admin rows never have
  const stripAdminId = (rows) => rows.map(({ admin_id, ...rest }) => rest);
  const batch = serversDb.getAccessibleServersBatch([admin1, admin2]);
  assert.deepEqual(stripAdminId(batch.get(admin1)), serversDb.getAccessibleServers(admin1));
  assert.deepEqual(stripAdminId(batch.get(admin2)), serversDb.getAccessibleServers(admin2));
});

test("getAccessibleServersBatch returns an empty-array entry for an admin with no access rows", () => {
  const admin = db.prepare("INSERT INTO admins (username, password_hash) VALUES (?, 'x')").run("batch-admin-none").lastInsertRowid;
  const batch = serversDb.getAccessibleServersBatch([admin]);
  assert.deepEqual(batch.get(admin), []);
});

test("getAccessibleServersBatch returns an empty map for an empty id list", () => {
  assert.deepEqual(serversDb.getAccessibleServersBatch([]), new Map());
});

test("listValidInvites uses getInviteAccessBatch and matches looping getInviteAccess per invite", () => {
  const server = db.prepare("INSERT INTO servers (slug, name, instance_name) VALUES ('b3', 'Server 3', 'i3')").run().lastInsertRowid;
  const invite1 = invitesDb.createInvite({ canManageAccounts: false }).id;
  const invite2 = invitesDb.createInvite({ canManageAccounts: true }).id;
  invitesDb.setInvitePermission(invite1, server, "view", true);

  const valid = invitesDb.listValidInvites();
  const byId = new Map(valid.map((i) => [i.id, i]));
  assert.deepEqual(byId.get(invite1).access, invitesDb.getInviteAccess(invite1));
  assert.deepEqual(byId.get(invite2).access, invitesDb.getInviteAccess(invite2));
});
