const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const VARS = ["AUTH_GATE_STATE_DIR", "WEBGUI_STATIC_PATH", "ACTIVE_SLOT_PATH", "AUTH_GATE_LOG_PATH", "SQLITE_PATH"];

// a clean require of stateDir.js, seeing only the env vars passed in
function freshStateDir(env) {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../src/stateDir")];
  return require("../src/stateDir");
}

test.after(() => {
  for (const name of VARS) delete process.env[name];
  delete require.cache[require.resolve("../src/stateDir")];
});

test("with no vars set, every path falls back to its original repo-relative default", () => {
  const stateDir = freshStateDir({});
  assert.equal(stateDir.WEBGUI_STATIC_PATH, path.join(__dirname, "..", "webgui-static"));
  assert.equal(stateDir.ACTIVE_SLOT_PATH, path.join(__dirname, "..", "active-slot"));
  assert.equal(stateDir.SQLITE_PATH, path.join(__dirname, "..", "local-only", "data", "auth-gate.sqlite"));
  assert.deepEqual(stateDir.deprecatedVarsSet, []);
});

test("AUTH_GATE_STATE_DIR derives all four paths as fixed sub-paths", () => {
  const stateDir = freshStateDir({ AUTH_GATE_STATE_DIR: "/srv/auth-gate" });
  assert.equal(stateDir.WEBGUI_STATIC_PATH, "/srv/auth-gate/webgui-static");
  assert.equal(stateDir.ACTIVE_SLOT_PATH, "/srv/auth-gate/active-slot");
  assert.equal(stateDir.AUTH_GATE_LOG_PATH, "/srv/auth-gate/auth-gate.log");
  assert.equal(stateDir.SQLITE_PATH, "/srv/auth-gate/auth-gate.sqlite");
  assert.deepEqual(stateDir.deprecatedVarsSet, []);
});

test("an old per-path var still wins over AUTH_GATE_STATE_DIR when both are set", () => {
  const stateDir = freshStateDir({ AUTH_GATE_STATE_DIR: "/srv/auth-gate", SQLITE_PATH: "/custom/db.sqlite" });
  assert.equal(stateDir.SQLITE_PATH, "/custom/db.sqlite");
  assert.equal(stateDir.ACTIVE_SLOT_PATH, "/srv/auth-gate/active-slot");
  assert.deepEqual(stateDir.deprecatedVarsSet, ["SQLITE_PATH"]);
});

test("deprecatedVarsSet lists exactly the old vars that are set, regardless of AUTH_GATE_STATE_DIR", () => {
  const stateDir = freshStateDir({ WEBGUI_STATIC_PATH: "/a", AUTH_GATE_LOG_PATH: "/b" });
  assert.deepEqual(stateDir.deprecatedVarsSet, ["WEBGUI_STATIC_PATH", "AUTH_GATE_LOG_PATH"]);
});
