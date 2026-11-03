const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "systemd", "dcs-webgui-auth-gate-rollback.sh");

// ROLLBACK_SKIP_RESTART is always set here: a test invoking this
// script directly must never reach the real systemctl commands
function runRollbackScript(env) {
  return execFileSync("sh", [SCRIPT_PATH], { env: { ...process.env, ROLLBACK_SKIP_RESTART: "1", ...env }, encoding: "utf8" });
}

test("the extracted rollback script flips the state file and writes one well-formed JSON log line", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-script-test-"));
  try {
    const stateFile = path.join(scratchDir, "active-slot");
    const logFile = path.join(scratchDir, "auth-gate.log");
    fs.writeFileSync(stateFile, "a");

    runRollbackScript({ ROLLBACK_STATE_FILE_OVERRIDE: stateFile, ROLLBACK_LOG_FILE_OVERRIDE: logFile });

    assert.equal(fs.readFileSync(stateFile, "utf8"), "b", "the script must flip the state file to the other slot");

    const logContents = fs.readFileSync(logFile, "utf8");
    assert.equal(logContents.endsWith("\n"), true, "the log line must end in a real trailing newline");
    const lines = logContents.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "exactly one well-formed line, not the repeated garbled blob the unescaped ExecStart version produced");
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, "warn");
    assert.match(parsed.msg, /active-slot a -> b/);
    assert.match(parsed.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("the extracted rollback script defaults to slot a when no state file exists yet, so it still flips to b", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-script-test-"));
  try {
    const stateFile = path.join(scratchDir, "active-slot");
    const logFile = path.join(scratchDir, "auth-gate.log");

    runRollbackScript({ ROLLBACK_STATE_FILE_OVERRIDE: stateFile, ROLLBACK_LOG_FILE_OVERRIDE: logFile });

    assert.equal(fs.readFileSync(stateFile, "utf8"), "b");
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("garbage state-file content is treated as slot a and never reaches the new state file or the log line", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-script-test-"));
  try {
    const stateFile = path.join(scratchDir, "active-slot");
    const logFile = path.join(scratchDir, "auth-gate.log");
    fs.writeFileSync(stateFile, "x\n* * * * * root /tmp/evil.sh #");

    runRollbackScript({ ROLLBACK_STATE_FILE_OVERRIDE: stateFile, ROLLBACK_LOG_FILE_OVERRIDE: logFile });

    assert.equal(fs.readFileSync(stateFile, "utf8"), "b", "garbage must map to slot a, which then flips to b");
    const logContents = fs.readFileSync(logFile, "utf8");
    assert.doesNotMatch(logContents, /evil\.sh|cron/, "the garbage content must never reach the log line");
    assert.match(JSON.parse(logContents.trim()).msg, /active-slot a -> b/);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("a state file that is a symlink is replaced by a plain file, leaving the symlink's original target untouched", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-script-test-"));
  try {
    const stateFile = path.join(scratchDir, "active-slot");
    const logFile = path.join(scratchDir, "auth-gate.log");
    const symlinkTarget = path.join(scratchDir, "some-other-root-file");
    fs.writeFileSync(symlinkTarget, "untouched");
    fs.symlinkSync(symlinkTarget, stateFile);

    runRollbackScript({ ROLLBACK_STATE_FILE_OVERRIDE: stateFile, ROLLBACK_LOG_FILE_OVERRIDE: logFile });

    assert.equal(fs.lstatSync(stateFile).isSymbolicLink(), false, "the state path must be a plain file afterward, not still a symlink");
    assert.equal(fs.readFileSync(stateFile, "utf8"), "b");
    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "untouched", "the original symlink target must be untouched");
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("a log file that is a symlink is left alone: the append is refused and the symlink's target is untouched", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-script-test-"));
  try {
    const stateFile = path.join(scratchDir, "active-slot");
    const logFile = path.join(scratchDir, "auth-gate.log");
    const symlinkTarget = path.join(scratchDir, "some-other-root-file");
    fs.writeFileSync(symlinkTarget, "untouched");
    fs.symlinkSync(symlinkTarget, logFile);
    fs.writeFileSync(stateFile, "a");

    runRollbackScript({ ROLLBACK_STATE_FILE_OVERRIDE: stateFile, ROLLBACK_LOG_FILE_OVERRIDE: logFile });

    assert.equal(fs.readFileSync(symlinkTarget, "utf8"), "untouched", "a symlinked log file must never be appended through");
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
