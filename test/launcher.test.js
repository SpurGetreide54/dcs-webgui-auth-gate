const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const VARS = ["ACTIVE_SLOT_PATH", "AUTH_GATE_STATE_DIR"];

// a clean require of launcher.js, seeing only the env vars passed in
function freshLauncher(env) {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, env);
  delete require.cache[require.resolve("../launcher")];
  return require("../launcher");
}

// same clean-require helper for stateDir.js, to compare against
function freshStateDir() {
  delete require.cache[require.resolve("../src/stateDir")];
  return require("../src/stateDir");
}

test.after(() => {
  for (const name of VARS) delete process.env[name];
  delete require.cache[require.resolve("../launcher")];
  delete require.cache[require.resolve("../src/stateDir")];
});

test("resolveActiveSlotPath follows the same env-var precedence as stateDir.js", () => {
  let launcher = freshLauncher({});
  assert.equal(launcher.resolveActiveSlotPath(), path.join(__dirname, "..", "active-slot"), "falls back to its own dir, next to launcher.js itself");

  launcher = freshLauncher({ AUTH_GATE_STATE_DIR: "/srv/auth-gate" });
  let stateDir = freshStateDir();
  assert.equal(launcher.resolveActiveSlotPath(), "/srv/auth-gate/active-slot");
  assert.equal(launcher.resolveActiveSlotPath(), stateDir.ACTIVE_SLOT_PATH, "must agree with activeSlot.js's own resolution");

  launcher = freshLauncher({ AUTH_GATE_STATE_DIR: "/srv/auth-gate", ACTIVE_SLOT_PATH: "/custom/active-slot" });
  stateDir = freshStateDir();
  assert.equal(launcher.resolveActiveSlotPath(), "/custom/active-slot", "the old per-path var still wins over AUTH_GATE_STATE_DIR");
  assert.equal(launcher.resolveActiveSlotPath(), stateDir.ACTIVE_SLOT_PATH);
});

test('readActiveSlot: missing file is "a", "b" content is "b", anything else is "a"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
  const slotPath = path.join(dir, "active-slot");
  const launcher = freshLauncher({ ACTIVE_SLOT_PATH: slotPath });

  assert.equal(launcher.readActiveSlot(), "a", "a missing file defaults to a");

  fs.writeFileSync(slotPath, "b");
  assert.equal(launcher.readActiveSlot(), "b");

  fs.writeFileSync(slotPath, "garbage");
  assert.equal(launcher.readActiveSlot(), "a");

  fs.rmSync(dir, { recursive: true, force: true });
});
