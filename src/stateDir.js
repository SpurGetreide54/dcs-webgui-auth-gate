// node's own path module
const path = require("node:path");

// optional single var every path below derives from when set, see
// docs/Why.md#why-does-auth_gate_state_dir-not-replace-the-older-vars
const STATE_DIR = process.env.AUTH_GATE_STATE_DIR || null;

// an old per-path var always wins when set, AUTH_GATE_STATE_DIR only
// fills in whichever of the four were left unset
function resolve(oldVarName, subPath, legacyDefault) {
  if (process.env[oldVarName]) return process.env[oldVarName];
  if (STATE_DIR) return path.join(STATE_DIR, subPath);
  return legacyDefault;
}

const WEBGUI_STATIC_PATH = resolve("WEBGUI_STATIC_PATH", "webgui-static", path.join(__dirname, "..", "webgui-static"));
const ACTIVE_SLOT_PATH = resolve("ACTIVE_SLOT_PATH", "active-slot", path.join(__dirname, "..", "active-slot"));
const AUTH_GATE_LOG_PATH = resolve(
  "AUTH_GATE_LOG_PATH",
  "auth-gate.log",
  path.join(__dirname, "..", "local-only", "auth-gate.log")
);
const SQLITE_PATH = resolve(
  "SQLITE_PATH",
  "auth-gate.sqlite",
  path.join(__dirname, "..", "local-only", "data", "auth-gate.sqlite")
);

// old vars that are still set, for the caller's startup deprecation warning
const deprecatedVarsSet = ["WEBGUI_STATIC_PATH", "ACTIVE_SLOT_PATH", "AUTH_GATE_LOG_PATH", "SQLITE_PATH"].filter(
  (name) => process.env[name]
);

module.exports = { WEBGUI_STATIC_PATH, ACTIVE_SLOT_PATH, AUTH_GATE_LOG_PATH, SQLITE_PATH, deprecatedVarsSet };
