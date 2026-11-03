// node's own filesystem, path and crypto modules
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// a plain flat file, not a db row, see db.js's update_state comment
// overridden in production via ACTIVE_SLOT_PATH or AUTH_GATE_STATE_DIR in .env
// see docs/Why.md#why-is-the-active-slot-pointer-a-flat-file
const { ACTIVE_SLOT_PATH } = require("./stateDir");

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
// writes to a tmp file first, then renames it into place, so a crash
// mid-write can never leave an empty or partial active-slot file
function writeActiveSlot(slot) {
  // refuse anything that isn't a real slot name
  if (slot !== "a" && slot !== "b") throw new Error(`Invalid slot: ${slot}`);
  const tmpPath = `${ACTIVE_SLOT_PATH}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmpPath, slot, "utf8");
  fs.renameSync(tmpPath, ACTIVE_SLOT_PATH);
}

// expose the path (other modules need it too) and all three functions
module.exports = { ACTIVE_SLOT_PATH, readActiveSlot, writeActiveSlot, otherSlot };
