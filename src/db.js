// node's path and filesystem modules, and the sqlite driver
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

// where the sqlite file lives, overridden in production via
// sqlite_path in .env, same reasoning as activeSlot.js's path
const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, "..", "local-only", "data", "auth-gate.sqlite");

// a fresh clone has no local-only/ on disk at all, make sure it exists
fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true });

// open the database and turn on the two pragmas this app relies on
const db = new Database(SQLITE_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// create every table this app needs, each one a no-op once it exists
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
    can_view_missions INTEGER NOT NULL DEFAULT 0,
    can_download_missions INTEGER NOT NULL DEFAULT 0,
    can_delete_missions INTEGER NOT NULL DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    can_manage_accounts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS invite_server_access (
    invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    can_upload_missions INTEGER NOT NULL DEFAULT 0,
    can_view_missions INTEGER NOT NULL DEFAULT 0,
    can_download_missions INTEGER NOT NULL DEFAULT 0,
    can_delete_missions INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (invite_id, server_id)
  );

  -- single row, id is always 1, tracks what the hourly github check
  -- last found, for the update tab ui, active slot is not here
  -- see docs/Why.md#why-is-the-active-slot-pointer-a-flat-file
  CREATE TABLE IF NOT EXISTS update_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_checked_at TEXT,
    available_version TEXT,
    changelog_url TEXT,
    needs_service_update INTEGER NOT NULL DEFAULT 0
  );

  -- generic site wide key/value settings, independent of any one
  -- subsystem's own state, the home for this and any future toggle
  -- instead of accumulating one-off columns on unrelated tables
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// seed the single update_state row, once, on the very first run
db.prepare("INSERT OR IGNORE INTO update_state (id) VALUES (1)").run();

// guarded migration from the old upstream_url/mission_folder_key
// columns, see docs/FAQ.md#why-does-this-project-exist-at-all for why
// a direct reverse proxy was dropped, a no-op once already migrated
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

// guarded migration adding view/download/delete as their own columns
// see docs/Why.md#why-does-the-permission-migration-backfill-from-upload
for (const table of ["admin_server_access", "invite_server_access"]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!columns.includes("can_view_missions")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN can_view_missions INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE ${table} SET can_view_missions = 1 WHERE can_upload_missions = 1`);
  }
  if (!columns.includes("can_download_missions")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN can_download_missions INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columns.includes("can_delete_missions")) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN can_delete_missions INTEGER NOT NULL DEFAULT 0`);
  }
}

// guarded migration adding update_triggered_at, the cooldown guard's
// own timestamp column
// see docs/Why.md#why-does-update-state-track-when-an-update-was-triggered
{
  const columns = db.prepare("PRAGMA table_info(update_state)").all().map((c) => c.name);
  if (!columns.includes("update_triggered_at")) {
    db.exec("ALTER TABLE update_state ADD COLUMN update_triggered_at TEXT");
  }
}

// expose the open, migrated database connection to every other module
module.exports = db;
