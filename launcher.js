// the one piece of the a/b self-update system that never gets
// replaced by it, see docs/Why.md#why-does-launcherjs-never-update-itself

// node's filesystem and path modules, nothing else, by design
const fs = require("node:fs");
const path = require("node:path");

// its own copy of stateDir.js's same env-var precedence for this one
// path, kept inline instead of requiring it, to stay at zero
// dependencies beyond node itself, see docs/Why.md#why-does-launcherjs-never-update-itself
function resolveActiveSlotPath() {
  if (process.env.ACTIVE_SLOT_PATH) return process.env.ACTIVE_SLOT_PATH;
  if (process.env.AUTH_GATE_STATE_DIR) return path.join(process.env.AUTH_GATE_STATE_DIR, "active-slot");
  return path.join(__dirname, "active-slot");
}

// read which slot ("a" or "b") is currently live, defaulting to "a"
function readActiveSlot() {
  try {
    const value = fs.readFileSync(resolveActiveSlotPath(), "utf8").trim();
    return value === "b" ? "b" : "a";
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return "a";
  }
}

// run the active slot's own real server, skipped when required by a test
if (require.main === module) {
  require(path.join(__dirname, "releases", readActiveSlot(), "src", "server.js")).start();
}

// expose both functions so a test can call them without starting the real server
module.exports = { resolveActiveSlotPath, readActiveSlot };
