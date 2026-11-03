const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `update-check-active-slot-guard-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

const sqlitePath = tempSqlitePath("main");
process.env.SQLITE_PATH = sqlitePath;
// deliberately never set: AUTH_GATE_STATE_DIR / ACTIVE_SLOT_PATH

// unreachable on purpose: a call that got past the fail-fast guard
// would surface as a connection error here, never confusable with
// this test's own expected rejection message
process.env.GITHUB_API_BASE_OVERRIDE = "http://127.0.0.1:1";

const updateCheck = require("../src/updateCheck");

test.after(() => {
  require("../src/db").close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
});

test("applyUpdate rejects before any network call when neither AUTH_GATE_STATE_DIR nor ACTIVE_SLOT_PATH is set", async () => {
  await assert.rejects(() => updateCheck.applyUpdate(), /AUTH_GATE_STATE_DIR/);
});
