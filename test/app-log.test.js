const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tempLogPath(label) {
  return path.join(os.tmpdir(), `app-log-test-${label}-${crypto.randomBytes(6).toString("hex")}.log`);
}

let logPath;
let appLog;

test.before(() => {
  logPath = tempLogPath("main");
  process.env.AUTH_GATE_LOG_PATH = logPath;
  appLog = require("../src/appLog");
});

test.after(() => {
  for (const suffix of ["", ".1"]) fs.rmSync(logPath + suffix, { force: true });
});

test("installConsoleCapture wraps console.log/warn/error: original still runs, and a structured line is appended", (t) => {
  const original = { log: console.log, warn: console.warn, error: console.error };
  const calls = [];
  console.log = (...args) => calls.push(["log", args]);
  console.warn = (...args) => calls.push(["warn", args]);
  console.error = (...args) => calls.push(["error", args]);
  t.after(() => Object.assign(console, original));

  appLog.installConsoleCapture();
  // installConsoleCapture() wraps whatever console.log/warn/error are at
  // call time -- which are now the test's own stub functions above, so
  // the "original still runs" half of this test is exercised through
  // those stubs rather than the real stdout.
  console.log("hello", 1);
  console.warn("careful");
  console.error("boom");

  assert.deepEqual(calls, [
    ["log", ["hello", 1]],
    ["warn", ["careful"]],
    ["error", ["boom"]],
  ]);

  const entries = appLog.readRecentEntries(10);
  const last3 = entries.slice(-3);
  assert.equal(last3[0].level, "log");
  assert.equal(last3[0].msg, "hello 1");
  assert.equal(last3[1].level, "warn");
  assert.equal(last3[1].msg, "careful");
  assert.equal(last3[2].level, "error");
  assert.equal(last3[2].msg, "boom");
  for (const entry of last3) assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/, "each entry needs a real ISO timestamp");
});

test("readRecentEntries returns only the last maxLines, most recent last", () => {
  fs.rmSync(logPath, { force: true });
  for (let i = 0; i < 20; i++) {
    fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), level: "log", msg: `line ${i}` }) + "\n");
  }
  const entries = appLog.readRecentEntries(5);
  assert.deepEqual(
    entries.map((e) => e.msg),
    ["line 15", "line 16", "line 17", "line 18", "line 19"]
  );
});

test("a line that fails to parse renders as a raw row instead of breaking the read", () => {
  fs.rmSync(logPath, { force: true });
  fs.appendFileSync(logPath, "not json at all\n");
  fs.appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), level: "log", msg: "a real entry" }) + "\n");

  const entries = appLog.readRecentEntries(10);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].level, "raw");
  assert.equal(entries[0].msg, "not json at all");
  assert.equal(entries[1].level, "log");
  assert.equal(entries[1].msg, "a real entry");
});

test("readRecentEntries returns an empty list when the log file doesn't exist yet", () => {
  const missingPath = tempLogPath("missing");
  const previous = process.env.AUTH_GATE_LOG_PATH;
  process.env.AUTH_GATE_LOG_PATH = missingPath;
  delete require.cache[require.resolve("../src/appLog")];
  const freshAppLog = require("../src/appLog");
  process.env.AUTH_GATE_LOG_PATH = previous;
  delete require.cache[require.resolve("../src/appLog")];

  assert.deepEqual(freshAppLog.readRecentEntries(10), []);
});

test("exceeding the size cap rotates the current file to .1 and starts fresh", () => {
  fs.rmSync(logPath, { force: true });
  fs.rmSync(`${logPath}.1`, { force: true });

  // A dedicated module instance with a tiny cap, so this doesn't need to
  // actually write 5MB to exercise rotation. MAX_LOG_BYTES itself isn't
  // exported/overridable, so this writes past the real default once
  // instead -- small, but real: a ~40-byte line repeated until the total
  // exceeds the cap would take forever to assert on, so this test instead
  // confirms the *mechanism* (rename-then-fresh-append) by pre-seeding a
  // file already past the cap and checking the next append rotates it.
  const oversized = "x".repeat(6 * 1024 * 1024);
  fs.writeFileSync(logPath, oversized);

  const original = { log: console.log };
  console.log = () => {};
  appLog.installConsoleCapture();
  console.log("after rotation");
  Object.assign(console, original);

  assert.ok(fs.existsSync(`${logPath}.1`), "the oversized file must be rotated aside");
  assert.equal(fs.readFileSync(`${logPath}.1`, "utf8"), oversized);
  const entries = appLog.readRecentEntries(10);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].msg, "after rotation");
});
