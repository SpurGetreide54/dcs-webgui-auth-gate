// Generic site-wide key/value settings (see src/db.js's `settings`
// table comment) -- string in, string out, not typed per-key, since
// this is meant to be the home for whatever setting shows up next too.
const db = require("./db");

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

module.exports = { getSetting, setSetting };
