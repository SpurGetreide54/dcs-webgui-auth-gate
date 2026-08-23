const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "local-only", "data", "auth-gate.sqlite");

fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });

const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    can_manage_accounts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    instance_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_server_access (
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    can_upload_missions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (admin_id, server_id)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Guarded migration for DBs created before the servers table dropped
// upstream_url and renamed mission_folder_key to instance_name. Direct
// reverse-proxying to a DCS host never actually worked -- its control port
// only accepts 127.0.0.1. instance_name now also locates
// Config/autoexec.cfg, not just the Missions folder. CREATE TABLE IF NOT
// EXISTS above never alters an existing table, so this runs every startup
// and is a no-op once migrated.
{
  const columns = db.prepare("PRAGMA table_info(servers)").all().map((c) => c.name);
  if (columns.includes("mission_folder_key") && !columns.includes("instance_name")) {
    db.exec("ALTER TABLE servers RENAME COLUMN mission_folder_key TO instance_name");
  }
  if (db.prepare("PRAGMA table_info(servers)").all().some((c) => c.name === "upstream_url")) {
    db.exec("ALTER TABLE servers DROP COLUMN upstream_url");
  }
  if (!db.prepare("PRAGMA table_info(servers)").all().some((c) => c.name === "dcs_install_path")) {
    db.exec("ALTER TABLE servers ADD COLUMN dcs_install_path TEXT");
  }
}

module.exports = db;
