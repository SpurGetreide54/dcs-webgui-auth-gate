const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `diagnostics-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

const MODULES_TO_RESET = ["../src/diagnostics", "../src/db", "../src/appLog", "../src/stateDir"];

// a fresh require of diagnostics.js, after any env var change, since
// several of its own dependencies read their env vars once at load time
function freshDiagnostics() {
  for (const m of MODULES_TO_RESET) delete require.cache[require.resolve(m)];
  return require("../src/diagnostics");
}

let sqlitePath, authGateLogPath;
let diagnostics;

test.before(() => {
  sqlitePath = tempSqlitePath("main");
  authGateLogPath = path.join(os.tmpdir(), `diagnostics-test-log-${crypto.randomBytes(6).toString("hex")}.log`);
  process.env.SQLITE_PATH = sqlitePath;
  process.env.AUTH_GATE_LOG_PATH = authGateLogPath;
  diagnostics = freshDiagnostics();
});

test.after(() => {
  require("../src/db").close();
  cleanupSqlite(sqlitePath);
  for (const suffix of ["", ".1"]) fs.rmSync(authGateLogPath + suffix, { force: true });
});

// appends one rollback-shaped log line, same shape the rollback
// systemd unit's own ExecStart writes
function writeRollbackLine(t) {
  fs.appendFileSync(authGateLogPath, JSON.stringify({ t, level: "warn", msg: "Rolled back: active-slot a -> b" }) + "\n");
}

test("getDiagnosticsState starts seeded with every column empty/zero", () => {
  const state = diagnostics.getDiagnosticsState();
  assert.equal(state.id, 1);
  assert.equal(state.last_checked_at, null);
  assert.equal(state.mission_agent_status, null);
  assert.equal(state.rollback_detected_at, null);
  assert.equal(state.webgui_static_empty, 0);
  assert.equal(state.deprecated_env_vars_detected, "");
});

test("checkMissionAgent: not_configured when the url/token env vars are empty", async () => {
  const previous = { url: process.env.MISSION_AGENT_URL, token: process.env.MISSION_AGENT_TOKEN };
  delete process.env.MISSION_AGENT_URL;
  delete process.env.MISSION_AGENT_TOKEN;
  const fresh = freshDiagnostics();
  assert.equal(await fresh.checkMissionAgent(), "not_configured");
  if (previous.url) process.env.MISSION_AGENT_URL = previous.url;
  if (previous.token) process.env.MISSION_AGENT_TOKEN = previous.token;
});

test("checkMissionAgent: ok, unauthorized, unexpected_response, and unreachable", async () => {
  let respond = (req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}');
  const dummyAgent = await startDummyHttpServer((req, res) => respond(req, res));
  const dummyAgentUrl = `http://127.0.0.1:${dummyAgent.address().port}`;

  process.env.MISSION_AGENT_URL = dummyAgentUrl;
  process.env.MISSION_AGENT_TOKEN = "test-token";
  let fresh = freshDiagnostics();
  assert.equal(await fresh.checkMissionAgent(), "ok");

  respond = (req, res) => res.writeHead(401).end("Invalid bearer token.");
  fresh = freshDiagnostics();
  assert.equal(await fresh.checkMissionAgent(), "unauthorized");

  respond = (req, res) => res.writeHead(500).end("boom");
  fresh = freshDiagnostics();
  assert.equal(await fresh.checkMissionAgent(), "unexpected_response");

  await new Promise((resolve) => dummyAgent.close(resolve));
  // the server just closed, so this URL is now definitely unreachable
  fresh = freshDiagnostics();
  assert.equal(await fresh.checkMissionAgent(), "unreachable");
});

test("checkWebguiStaticEmpty: true when missing, true when empty, false once populated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "diagnostics-webgui-static-"));
  process.env.WEBGUI_STATIC_PATH = path.join(dir, "does-not-exist");
  let fresh = freshDiagnostics();
  assert.equal(fresh.checkWebguiStaticEmpty(), true, "a missing directory counts as empty");

  const emptyDir = path.join(dir, "empty");
  fs.mkdirSync(emptyDir);
  process.env.WEBGUI_STATIC_PATH = emptyDir;
  fresh = freshDiagnostics();
  assert.equal(fresh.checkWebguiStaticEmpty(), true, "an existing but empty directory also counts as empty");

  fs.writeFileSync(path.join(emptyDir, "index.html"), "<html></html>");
  fresh = freshDiagnostics();
  assert.equal(fresh.checkWebguiStaticEmpty(), false);

  delete process.env.WEBGUI_STATIC_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("checkRollback: detects a new rollback, then leaves it alone on the next scan", () => {
  fs.rmSync(authGateLogPath, { force: true });
  diagnostics.checkRollback();
  assert.equal(diagnostics.getDiagnosticsState().rollback_detected_at, null, "nothing in the log yet");

  writeRollbackLine("2026-11-01T10:00:00.000Z");
  diagnostics.checkRollback();
  let state = diagnostics.getDiagnosticsState();
  assert.equal(state.rollback_detected_at, "2026-11-01T10:00:00.000Z");
  assert.equal(state.rollback_seen_at, null);
  assert.equal(state.rollback_dismissed_at, null);

  // mark it seen, as a real /admin/diag visit would, then rescan: a
  // repeat scan of the SAME rollback must not clobber that seen flag
  diagnostics.markRollbackSeen();
  diagnostics.checkRollback();
  state = diagnostics.getDiagnosticsState();
  assert.ok(state.rollback_seen_at, "re-scanning the same rollback must not erase the seen flag");

  // a second, later rollback: must be treated as fresh again
  writeRollbackLine("2026-11-01T12:00:00.000Z");
  diagnostics.checkRollback();
  state = diagnostics.getDiagnosticsState();
  assert.equal(state.rollback_detected_at, "2026-11-01T12:00:00.000Z");
  assert.equal(state.rollback_seen_at, null, "a genuinely new rollback resets the seen flag");
});

test("dismissRollback and clearRollback", () => {
  fs.rmSync(authGateLogPath, { force: true });
  writeRollbackLine("2026-11-01T14:00:00.000Z");
  diagnostics.checkRollback();
  assert.ok(diagnostics.getDiagnosticsState().rollback_detected_at);

  diagnostics.dismissRollback();
  assert.ok(diagnostics.getDiagnosticsState().rollback_dismissed_at);

  diagnostics.clearRollback();
  const state = diagnostics.getDiagnosticsState();
  assert.ok(state.rollback_detected_at, "clearRollback marks it resolved, it doesn't erase the record");
  assert.ok(state.rollback_dismissed_at);
});

test("clearRollback survives a rescan of the same unchanged log, but a genuinely new rollback still surfaces", () => {
  fs.rmSync(authGateLogPath, { force: true });
  writeRollbackLine("2026-11-01T18:00:00.000Z");
  diagnostics.checkRollback();
  diagnostics.clearRollback();

  // same log, no new line: a restart's rescan must not resurrect it
  diagnostics.checkRollback();
  let issues = diagnostics.getActiveIssues({
    updateState: { last_checked_at: new Date().toISOString() },
    updateCheckIntervalMs: 60 * 60 * 1000,
    staleMultiplier: 3,
  });
  assert.ok(!issues.map((i) => i.key).includes("rollback"), "a cleared rollback must stay resolved across a rescan");

  // a later, genuinely new rollback must still be detected
  writeRollbackLine("2026-11-01T20:00:00.000Z");
  diagnostics.checkRollback();
  issues = diagnostics.getActiveIssues({
    updateState: { last_checked_at: new Date().toISOString() },
    updateCheckIntervalMs: 60 * 60 * 1000,
    staleMultiplier: 3,
  });
  assert.ok(issues.map((i) => i.key).includes("rollback"), "a new rollback after a resolved one must still surface");

  // leave state clean for the tests that follow
  diagnostics.dismissRollback();
});

test("isUpdateCheckStale", () => {
  const hourMs = 60 * 60 * 1000;
  assert.equal(diagnostics.isUpdateCheckStale({ last_succeeded_at: null }, hourMs, 3), true, "never succeeded counts as stale");
  assert.equal(
    diagnostics.isUpdateCheckStale({ last_succeeded_at: new Date().toISOString() }, hourMs, 3),
    false,
    "just succeeded is not stale"
  );
  const fourHoursAgo = new Date(Date.now() - 4 * hourMs).toISOString();
  assert.equal(
    diagnostics.isUpdateCheckStale({ last_succeeded_at: fourHoursAgo }, hourMs, 3),
    true,
    "past 3x the interval since the last success is stale"
  );

  // the actual bug: a check that keeps failing but still updates
  // last_checked_at every time must not look fresh because of that
  assert.equal(
    diagnostics.isUpdateCheckStale({ last_checked_at: new Date().toISOString(), last_succeeded_at: fourHoursAgo }, hourMs, 3),
    true,
    "a recent failed attempt must not mask an old last success"
  );
});

test("getActiveIssues assembles every currently-active issue, dismissed rollback excluded", () => {
  delete process.env.MISSION_AGENT_URL;
  delete process.env.MISSION_AGENT_TOKEN;
  delete process.env.WEBGUI_STATIC_PATH;
  // unrelated to this test's own issues; set so active_slot_path_mismatch
  // never fires here, covered by its own test below instead
  process.env.ACTIVE_SLOT_PATH = path.join(os.tmpdir(), "diagnostics-test-active-slot");
  const fresh = freshDiagnostics();
  fs.rmSync(authGateLogPath, { force: true });

  const hourMs = 60 * 60 * 1000;
  const freshUpdateState = { last_succeeded_at: new Date().toISOString() };
  const staleUpdateState = { last_succeeded_at: new Date(Date.now() - 10 * hourMs).toISOString() };

  // nothing configured yet, no rollback, update check fresh, static populated
  let issues = fresh.getActiveIssues({ updateState: freshUpdateState, updateCheckIntervalMs: hourMs, staleMultiplier: 3 });
  assert.deepEqual(issues.map((i) => i.key), [], "mission_agent_status/webgui_static_empty are still null/0 until a cycle runs");

  // run one cycle so mission_agent_status and webgui_static_empty are populated
  return fresh.runDiagnosticsCheck().then(() => {
    issues = fresh.getActiveIssues({ updateState: staleUpdateState, updateCheckIntervalMs: hourMs, staleMultiplier: 3 });
    const keys = issues.map((i) => i.key);
    assert.ok(keys.includes("mission_agent"), "not_configured must surface as an issue");
    assert.ok(keys.includes("update_check_stale"));
    // only the rollback check has a seen/fresh distinction, every
    // other issue type must always render at full severity, never muted
    for (const issue of issues) assert.equal(issue.seen, false, `${issue.key} must never report seen: true`);

    writeRollbackLine("2026-11-01T16:00:00.000Z");
    fresh.checkRollback();
    issues = fresh.getActiveIssues({ updateState: freshUpdateState, updateCheckIntervalMs: hourMs, staleMultiplier: 3 });
    const rollbackIssue = issues.find((i) => i.key === "rollback");
    assert.ok(rollbackIssue);
    assert.equal(rollbackIssue.seen, false, "a freshly-detected rollback must render highlighted, not muted");

    fresh.markRollbackSeen();
    issues = fresh.getActiveIssues({ updateState: freshUpdateState, updateCheckIntervalMs: hourMs, staleMultiplier: 3 });
    assert.equal(issues.find((i) => i.key === "rollback").seen, true, "after a visit, the same rollback renders muted");

    fresh.dismissRollback();
    issues = fresh.getActiveIssues({ updateState: freshUpdateState, updateCheckIntervalMs: hourMs, staleMultiplier: 3 });
    assert.ok(!issues.map((i) => i.key).includes("rollback"), "a dismissed rollback must not appear as active");
  });
});

test("getActiveIssues flags active_slot_path_mismatch when neither AUTH_GATE_STATE_DIR nor ACTIVE_SLOT_PATH is set, and omits it once either is", () => {
  const savedStateDir = process.env.AUTH_GATE_STATE_DIR;
  const savedActiveSlot = process.env.ACTIVE_SLOT_PATH;
  delete process.env.AUTH_GATE_STATE_DIR;
  delete process.env.ACTIVE_SLOT_PATH;
  try {
    const neither = freshDiagnostics();
    const updateState = { last_succeeded_at: new Date().toISOString() };
    let issues = neither.getActiveIssues({ updateState, updateCheckIntervalMs: 60 * 60 * 1000, staleMultiplier: 3 });
    assert.ok(issues.map((i) => i.key).includes("active_slot_path_mismatch"), "must flag when neither var is set");

    process.env.ACTIVE_SLOT_PATH = path.join(os.tmpdir(), "diagnostics-test-active-slot-2");
    const withActiveSlot = freshDiagnostics();
    issues = withActiveSlot.getActiveIssues({ updateState, updateCheckIntervalMs: 60 * 60 * 1000, staleMultiplier: 3 });
    assert.ok(!issues.map((i) => i.key).includes("active_slot_path_mismatch"), "must not flag once ACTIVE_SLOT_PATH is set");
  } finally {
    if (savedStateDir === undefined) delete process.env.AUTH_GATE_STATE_DIR;
    else process.env.AUTH_GATE_STATE_DIR = savedStateDir;
    if (savedActiveSlot === undefined) delete process.env.ACTIVE_SLOT_PATH;
    else process.env.ACTIVE_SLOT_PATH = savedActiveSlot;
  }
});

test("runDiagnosticsCheck records last_checked_at even when an individual check throws", async () => {
  process.env.WEBGUI_STATIC_PATH = "/dev/null/not-a-real-parent-dir/webgui-static";
  const fresh = freshDiagnostics();
  await fresh.runDiagnosticsCheck();
  // /dev/null as a path component makes readdirSync throw ENOTDIR,
  // not ENOENT, so checkWebguiStaticEmpty's own re-throw exercises
  // runDiagnosticsCheck's outer catch, not checkWebguiStaticEmpty's own
  const state = fresh.getDiagnosticsState();
  assert.ok(state.last_checked_at, "the attempt must still be recorded even though a check failed");
  delete process.env.WEBGUI_STATIC_PATH;
});
