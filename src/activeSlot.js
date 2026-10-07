const fs = require("node:fs");
const path = require("node:path");

// A plain flat file, not a DB row -- see db.js's update_state comment for
// why. Under the A/B layout this file lives at the shared top level
// (releases/a/ and releases/b/ are siblings of it, not parents), so the
// default here (repo-root-relative, right for a plain single-checkout
// local dev setup) is wrong in production and must be overridden --
// ACTIVE_SLOT_PATH=/var/www/dcs-webgui-auth-gate/active-slot in the shared
// .env, set once during the A/B migration, same as WEBGUI_STATIC_PATH.
const ACTIVE_SLOT_PATH = process.env.ACTIVE_SLOT_PATH || path.join(__dirname, "..", "active-slot");

function readActiveSlot() {
  try {
    const value = fs.readFileSync(ACTIVE_SLOT_PATH, "utf8").trim();
    return value === "b" ? "b" : "a";
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return "a";
  }
}

function otherSlot(slot) {
  return slot === "a" ? "b" : "a";
}

function writeActiveSlot(slot) {
  if (slot !== "a" && slot !== "b") throw new Error(`Invalid slot: ${slot}`);
  fs.writeFileSync(ACTIVE_SLOT_PATH, slot, "utf8");
}

module.exports = { ACTIVE_SLOT_PATH, readActiveSlot, writeActiveSlot, otherSlot };
