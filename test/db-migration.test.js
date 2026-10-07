const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

function tempSqlitePath() {
  return path.join(os.tmpdir(), `auth-gate-migration-test-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

test("upgrading an existing DB auto-grants view wherever upload was already set, and adds download/delete as 0", () => {
  const sqlitePath = tempSqlitePath();
  try {
    // Simulate a pre-upgrade DB: admin_server_access with only the
    // original column, one admin with upload-granted access to one
    // server and plain access (no upload) to another.
    const pre = new Database(sqlitePath);
    pre.exec(`
      CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT, password_hash TEXT, can_manage_accounts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE servers (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, instance_name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE admin_server_access (admin_id INTEGER NOT NULL, server_id INTEGER NOT NULL, can_upload_missions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (admin_id, server_id));
    `);
    pre.prepare("INSERT INTO admins (id, username, password_hash) VALUES (1, 'old-admin', 'hash')").run();
    pre.prepare("INSERT INTO servers (id, slug, name, instance_name) VALUES (1, 'srv-a', 'Server A', 'Server A')").run();
    pre.prepare("INSERT INTO servers (id, slug, name, instance_name) VALUES (2, 'srv-b', 'Server B', 'Server B')").run();
    pre.prepare("INSERT INTO admin_server_access (admin_id, server_id, can_upload_missions) VALUES (1, 1, 1)").run();
    pre.prepare("INSERT INTO admin_server_access (admin_id, server_id, can_upload_missions) VALUES (1, 2, 0)").run();
    pre.close();

    process.env.SQLITE_PATH = sqlitePath;
    const db = require("../src/db");

    const uploaded = db.prepare("SELECT * FROM admin_server_access WHERE server_id = 1").get();
    assert.equal(uploaded.can_view_missions, 1, "view must be auto-granted wherever upload was already set, so nobody silently loses page access on upgrade");
    assert.equal(uploaded.can_download_missions, 0, "download must default to 0, not inherit from upload");
    assert.equal(uploaded.can_delete_missions, 0, "delete must default to 0, not inherit from upload");

    const notUploaded = db.prepare("SELECT * FROM admin_server_access WHERE server_id = 2").get();
    assert.equal(notUploaded.can_view_missions, 0, "view must stay 0 where upload was never granted");

    db.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
  }
});
