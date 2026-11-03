// node's path and filesystem modules, and the sqlite driver
const path = require("node:path");
const fs = require("node:fs");
const Database = require("better-sqlite3");

// where the sqlite file lives, overridden in production via
// sqlite_path (or auth_gate_state_dir) in .env
const { SQLITE_PATH } = require("./stateDir");

// the key-rotation trust root's two initial public keys, for seeding
// key_state below
const { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM, INITIAL_KEY_ROTATED_AT } = require("./keyRotationConstants");

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

  -- single row, same id = 1 convention as update_state, tracks every
  -- diagnostics check's own result, for /admin/diag
  -- see docs/Why.md#why-does-diagnostics-mirror-updatecheckjss-own-shape
  CREATE TABLE IF NOT EXISTS diagnostics_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),

    -- when the periodic checks below (everything except the env-var
    -- one, which only runs once at startup) last ran, success or not
    last_checked_at TEXT,

    -- mission-agent connectivity, from GET /ping
    mission_agent_status TEXT,

    -- last self-update rollback, scanned from auth-gate.log
    rollback_detected_at TEXT,
    rollback_seen_at TEXT,
    rollback_dismissed_at TEXT,

    -- webgui-static/ directory check
    webgui_static_empty INTEGER NOT NULL DEFAULT 0,

    -- env vars read once at process startup, never rechecked until restart
    deprecated_env_vars_detected TEXT NOT NULL DEFAULT ''
  );

  -- single row, same id = 1 convention, the self-update signing-key
  -- rotation trust root: two slots, checked hourly against a
  -- dedicated github release tag, independent of signed_updates.json
  -- see docs/Why.md#why-is-key-staterotation-a-separate-signed-record
  CREATE TABLE IF NOT EXISTS key_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_checked_at TEXT,
    primary_public_key_pem TEXT NOT NULL,
    primary_rotated_at TEXT NOT NULL,
    primary_next_target_rotation_at TEXT,
    secondary_public_key_pem TEXT NOT NULL,
    secondary_rotated_at TEXT NOT NULL,
    secondary_next_target_rotation_at TEXT
  );
`);

// seed the single update_state row, once, on the very first run
db.prepare("INSERT OR IGNORE INTO update_state (id) VALUES (1)").run();
// seed the single diagnostics_state row, same reasoning
db.prepare("INSERT OR IGNORE INTO diagnostics_state (id) VALUES (1)").run();
// seed the single key_state row with the two hardcoded initial keys
db.prepare(
  `INSERT OR IGNORE INTO key_state (id, primary_public_key_pem, primary_rotated_at, secondary_public_key_pem, secondary_rotated_at)
   VALUES (1, ?, ?, ?, ?)`
).run(PRIMARY_PUBLIC_KEY_PEM, INITIAL_KEY_ROTATED_AT, SECONDARY_PUBLIC_KEY_PEM, INITIAL_KEY_ROTATED_AT);

// adds a column to a table unless it's already there
// returns whether it actually ran the ALTER TABLE, so a caller can
// conditionally follow up (e.g. backfilling the new column)
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (columns.includes(column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

// guarded migration from the old upstream_url/mission_folder_key
// columns, see docs/FAQ.md#why-does-this-project-exist-at-all for why
// a direct reverse proxy was dropped, a no-op once already migrated
{
  const columns = db.prepare("PRAGMA table_info(servers)").all().map((c) => c.name);
  if (columns.includes("mission_folder_key") && !columns.includes("instance_name")) {
    db.exec("ALTER TABLE servers RENAME COLUMN mission_folder_key TO instance_name");
  }
  if (columns.includes("upstream_url")) {
    db.exec("ALTER TABLE servers DROP COLUMN upstream_url");
  }
  addColumnIfMissing("servers", "dcs_install_path", "TEXT");
}

// guarded migration adding view/download/delete as their own columns
// see docs/Why.md#why-does-the-permission-migration-backfill-from-can_upload_missions
for (const table of ["admin_server_access", "invite_server_access"]) {
  if (addColumnIfMissing(table, "can_view_missions", "INTEGER NOT NULL DEFAULT 0")) {
    db.exec(`UPDATE ${table} SET can_view_missions = 1 WHERE can_upload_missions = 1`);
  }
  addColumnIfMissing(table, "can_download_missions", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(table, "can_delete_missions", "INTEGER NOT NULL DEFAULT 0");
}

// guarded migration adding update_triggered_at, the cooldown guard's
// own timestamp column
// see docs/Why.md#why-does-update_state-track-when-an-update-was-last-triggered
addColumnIfMissing("update_state", "update_triggered_at", "TEXT");

// guarded migration adding last_succeeded_at, split from
// last_checked_at so a check that fails every time doesn't look fresh
// see docs/Why.md#why-does-update_state-track-last_succeeded_at-separately-from-last_checked_at
addColumnIfMissing("update_state", "last_succeeded_at", "TEXT");

// expose the open, migrated database connection to every other module
module.exports = db;
// exposed so a test can exercise it directly
module.exports.addColumnIfMissing = addColumnIfMissing;
