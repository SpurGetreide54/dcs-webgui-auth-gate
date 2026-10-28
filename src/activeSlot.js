// node's own filesystem and path modules
const fs = require("node:fs");
const path = require("node:path");

// a plain flat file, not a db row, see db.js's update_state comment
// the path must be overridden in production via active_slot_path in
// .env, see docs/Why.md#why-is-the-active-slot-pointer-a-flat-file
const ACTIVE_SLOT_PATH = process.env.ACTIVE_SLOT_PATH || path.join(__dirname, "..", "active-slot");

// read which slot ("a" or "b") is currently live, defaulting to "a"
function readActiveSlot() {
  try {
    // read the file and strip the trailing newline
    const value = fs.readFileSync(ACTIVE_SLOT_PATH, "utf8").trim();
    // only "b" counts as b, anything else (including garbage) is a
    return value === "b" ? "b" : "a";
  } catch (err) {
    // a missing file means no slot has ever been written yet
    if (err.code !== "ENOENT") throw err;
    return "a";
  }
}

// return whichever slot isn't the one passed in
function otherSlot(slot) {
  return slot === "a" ? "b" : "a";
}

// write which slot is now live
function writeActiveSlot(slot) {
  // refuse anything that isn't a real slot name
  if (slot !== "a" && slot !== "b") throw new Error(`Invalid slot: ${slot}`);
  fs.writeFileSync(ACTIVE_SLOT_PATH, slot, "utf8");
}

// expose the path (other modules need it too) and all three functions
module.exports = { ACTIVE_SLOT_PATH, readActiveSlot, writeActiveSlot, otherSlot };
