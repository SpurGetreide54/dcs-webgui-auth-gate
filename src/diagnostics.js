// early, clearer surfacing of problems this app already logs or
// documents somewhere, mirrors updateCheck.js's own polling shape
// see docs/Why.md#why-does-diagnostics-mirror-updatecheckjss-own-shape

const fs = require("node:fs");
const db = require("./db");
const appLog = require("./appLog");
const stateDir = require("./stateDir");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// how many missed hourly update checks in a row count as "keeps
// failing", overridable from /admin/settings
const DEFAULT_STALE_MULTIPLIER = 3;
const PING_TIMEOUT_MS = 5 * 1000;
const ROLLBACK_LOG_SCAN_LINES = 1000;
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;

// the rollback unit's own exact log line, see
// scripts/systemd/dcs-webgui-auth-gate-rollback.service
const ROLLBACK_LOG_MARKER = "Rolled back: active-slot";

// section: diagnostics_state, the display-only cache of every check

// read the single diagnostics_state row
function getDiagnosticsState() {
  return db.prepare("SELECT * FROM diagnostics_state WHERE id = 1").get();
}

// merge the given fields into the single diagnostics_state row,
// leaving every other column as it already was
function updateDiagnosticsState(fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;
  const assignments = columns.map((c) => `${c} = ?`).join(", ");
  db.prepare(`UPDATE diagnostics_state SET ${assignments} WHERE id = 1`).run(...columns.map((c) => fields[c]));
}

// section: mission-agent connectivity, via the new GET /ping

// one of "ok" | "not_configured" | "unreachable" | "unauthorized" | "unexpected_response"
async function checkMissionAgent() {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) return "not_configured";
  let res;
  try {
    res = await fetch(new URL("/ping", MISSION_AGENT_URL), {
      headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` },
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  } catch {
    // connection refused, timeout, dns failure: all the same to an admin
    return "unreachable";
  }
  if (res.status === 401) return "unauthorized";
  if (!res.ok) return "unexpected_response";
  return "ok";
}

// section: self-update rollback, scanned from the shared app log

// records a newly-seen rollback, leaves an already-recorded one (and
// any seen/dismissed flags an admin already set on it) untouched
function checkRollback() {
  const matches = appLog
    .readRecentEntries(ROLLBACK_LOG_SCAN_LINES)
    .filter((e) => typeof e.msg === "string" && e.msg.includes(ROLLBACK_LOG_MARKER));
  if (matches.length === 0) return;
  const latestTimestamp = matches[matches.length - 1].t;
  const state = getDiagnosticsState();
  if (state.rollback_detected_at === latestTimestamp) return;
  updateDiagnosticsState({ rollback_detected_at: latestTimestamp, rollback_seen_at: null, rollback_dismissed_at: null });
}

// called once a site admin's first /admin/diag visit sees it
function markRollbackSeen() {
  const state = getDiagnosticsState();
  if (state.rollback_detected_at && !state.rollback_seen_at) {
    updateDiagnosticsState({ rollback_seen_at: new Date().toISOString() });
  }
}

// an explicit admin dismiss, hides it until a genuinely new rollback happens
function dismissRollback() {
  updateDiagnosticsState({ rollback_dismissed_at: new Date().toISOString() });
}

// called by updateCheck.js right after a successful flip: a fresh
// update with no new rollback is itself the "resolved" signal
function clearRollback() {
  updateDiagnosticsState({ rollback_detected_at: null, rollback_seen_at: null, rollback_dismissed_at: null });
}

// section: webgui-static/ emptiness

// true if WEBGUI_STATIC_PATH doesn't exist, or exists with nothing in it
function checkWebguiStaticEmpty() {
  try {
    return fs.readdirSync(stateDir.WEBGUI_STATIC_PATH).length === 0;
  } catch (err) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

// section: deprecated A/B env vars, read once at startup, never rechecked

// writes the current process's deprecated vars into the row once;
// static for the process's whole lifetime, see
// docs/Why.md#why-does-auth_gate_state_dir-not-replace-the-older-vars
function recordDeprecatedEnvVarsOnce() {
  updateDiagnosticsState({ deprecated_env_vars_detected: stateDir.deprecatedVarsSet.join(",") });
}

// section: the periodic check cycle, this app's own poller shape

// runs every check above except the startup-only env-var one,
// swallowing (not throwing) any single check's own failure
async function runDiagnosticsCheck() {
  const now = new Date().toISOString();
  try {
    const missionAgentStatus = await checkMissionAgent();
    checkRollback();
    updateDiagnosticsState({
      last_checked_at: now,
      mission_agent_status: missionAgentStatus,
      webgui_static_empty: checkWebguiStaticEmpty() ? 1 : 0,
    });
  } catch (err) {
    console.warn(`Diagnostics check failed: ${err.message}`);
    updateDiagnosticsState({ last_checked_at: now });
  }
}

// start the periodic background poll, immediate first run, never
// keeps the process alive on its own, same shape as startHourlyCheck()
function startDiagnosticsCheck() {
  recordDeprecatedEnvVarsOnce();
  runDiagnosticsCheck();
  const timer = setInterval(runDiagnosticsCheck, CHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

// section: assembling what /admin/diag and the sidebar icon actually show

// true if the hourly update check hasn't succeeded within
// multiplier * its own interval, read live, no column of its own
function isUpdateCheckStale(updateState, updateCheckIntervalMs, multiplier) {
  if (!updateState.last_checked_at) return true;
  const age = Date.now() - new Date(updateState.last_checked_at).getTime();
  return age > updateCheckIntervalMs * multiplier;
}

// every currently-active issue, most-severe concerns first, each
// with the explanation and troubleshooting link the UI shows
function getActiveIssues({ updateState, updateCheckIntervalMs, staleMultiplier }) {
  const state = getDiagnosticsState();
  const issues = [];

  if (state.mission_agent_status === "not_configured") {
    issues.push({
      key: "mission_agent",
      severity: "warning",
      message: "The mission agent is not configured yet (MISSION_AGENT_URL/MISSION_AGENT_TOKEN).",
      link: "Troubleshooting.md#the-mission-agent-rejects-every-request",
      seen: false,
    });
  } else if (state.mission_agent_status && state.mission_agent_status !== "ok") {
    issues.push({
      key: "mission_agent",
      severity: "error",
      message: `The mission agent is not reachable (${state.mission_agent_status}).`,
      link: "Troubleshooting.md#the-mission-agent-rejects-every-request",
      seen: false,
    });
  }

  if (state.rollback_detected_at && !state.rollback_dismissed_at) {
    issues.push({
      key: "rollback",
      severity: "error",
      message: `The last self-update rolled back, at ${state.rollback_detected_at}.`,
      link: "Troubleshooting.md#clicking-update-now-does-nothing-visible-or-the-service-never-comes-back",
      seen: Boolean(state.rollback_seen_at),
    });
  }

  if (isUpdateCheckStale(updateState, updateCheckIntervalMs, staleMultiplier)) {
    issues.push({
      key: "update_check_stale",
      severity: "warning",
      message: "The periodic update check keeps failing.",
      link: "Troubleshooting.md#the-update-sidebar-icon-never-appears-even-after-a-real-release",
      seen: false,
    });
  }

  if (state.webgui_static_empty) {
    issues.push({
      key: "webgui_static_empty",
      severity: "error",
      message: "webgui-static/ is empty.",
      link: "Troubleshooting.md#s-slug-returns-503",
      seen: false,
    });
  }

  if (state.deprecated_env_vars_detected) {
    issues.push({
      key: "deprecated_env_vars",
      severity: "warning",
      message: `Deprecated env var(s) still set: ${state.deprecated_env_vars_detected}.`,
      link: "Configuration.md#deprecated-still-work",
      seen: false,
    });
  }

  return issues;
}

module.exports = {
  CHECK_INTERVAL_MS,
  DEFAULT_STALE_MULTIPLIER,
  getDiagnosticsState,
  checkMissionAgent,
  checkRollback,
  checkWebguiStaticEmpty,
  markRollbackSeen,
  dismissRollback,
  clearRollback,
  runDiagnosticsCheck,
  startDiagnosticsCheck,
  isUpdateCheckStale,
  getActiveIssues,
};
