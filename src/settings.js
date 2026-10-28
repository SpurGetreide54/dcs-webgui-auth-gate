// generic site-wide key/value settings, string in string out, not
// typed per-key, see db.js's settings table comment for why, this is
// the home for whatever setting shows up next too
const db = require("./db");

// read a setting's value, or null if it was never set
function getSetting(key) {
  // look up the row for this key
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  // fall back to null when there's no row yet
  return row ? row.value : null;
}

// write a setting's value, overwriting any existing row for this key
function setSetting(key, value) {
  // insert a new row, or update the existing one on a key clash
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// expose both functions to callers
module.exports = { getSetting, setSetting };
