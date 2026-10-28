// the one piece of the a/b self-update system that never gets
// replaced by it, see docs/Why.md#why-does-launcher-never-update-itself

// node's filesystem and path modules, nothing else, by design
const fs = require("node:fs");
const path = require("node:path");

// its own copy of activeSlot.js's read, see the same Why.md entry
const ACTIVE_SLOT_PATH = path.join(__dirname, "active-slot");

let slot;
try {
  const value = fs.readFileSync(ACTIVE_SLOT_PATH, "utf8").trim();
  slot = value === "b" ? "b" : "a";
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  slot = "a";
}

// run the active slot's own real server
require(path.join(__dirname, "releases", slot, "src", "server.js")).start();
