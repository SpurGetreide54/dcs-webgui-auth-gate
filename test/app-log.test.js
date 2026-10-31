const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// a fresh, unique log path per test, under the os temp dir
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

test("installConsoleCapture wraps console.log/warn/error/debug: original still runs, and a structured line is appended", (t) => {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  const calls = [];
  console.log = (...args) => calls.push(["log", args]);
  console.warn = (...args) => calls.push(["warn", args]);
  console.error = (...args) => calls.push(["error", args]);
  console.debug = (...args) => calls.push(["debug", args]);
  t.after(() => Object.assign(console, original));

  appLog.installConsoleCapture();
  // wraps whatever console.* is at call time, the stubs above, so
  // "original still runs" is exercised through those, not real stdout
  console.log("hello", 1);
  console.warn("careful");
  console.error("boom");
  console.debug("step 1 of 3");

  assert.deepEqual(calls, [
    ["log", ["hello", 1]],
    ["warn", ["careful"]],
    ["error", ["boom"]],
    ["debug", ["step 1 of 3"]],
  ]);

  const entries = appLog.readRecentEntries(10);
  const last4 = entries.slice(-4);
  assert.equal(last4[0].level, "log");
  assert.equal(last4[0].msg, "hello 1");
  assert.equal(last4[1].level, "warn");
  assert.equal(last4[1].msg, "careful");
  assert.equal(last4[2].level, "error");
  assert.equal(last4[2].msg, "boom");
  assert.equal(last4[3].level, "debug");
  assert.equal(last4[3].msg, "step 1 of 3");
  for (const entry of last4) assert.match(entry.t, /^\d{4}-\d{2}-\d{2}T/, "each entry needs a real ISO timestamp");
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
  // appLog reads its path from stateDir, clear both so the fresh
  // require actually picks up missingPath instead of the cached one
  delete require.cache[require.resolve("../src/appLog")];
  delete require.cache[require.resolve("../src/stateDir")];
  const freshAppLog = require("../src/appLog");
  process.env.AUTH_GATE_LOG_PATH = previous;
  delete require.cache[require.resolve("../src/appLog")];
  delete require.cache[require.resolve("../src/stateDir")];

  assert.deepEqual(freshAppLog.readRecentEntries(10), []);
});

test("exceeding the size cap rotates the current file to .1 and starts fresh", () => {
  fs.rmSync(logPath, { force: true });
  fs.rmSync(`${logPath}.1`, { force: true });

  // MAX_LOG_BYTES isn't overridable, so this pre-seeds a file already
  // past the real cap and checks the next append rotates it, confirming
  // the rename-then-fresh-append mechanism without writing 5mb for real
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
