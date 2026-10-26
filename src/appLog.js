const fs = require("node:fs");
const path = require("node:path");

// Under the A/B layout this file lives at the shared top level (releases/a/
// and releases/b/ are siblings of it, not parents) -- same reasoning as
// src/activeSlot.js's ACTIVE_SLOT_PATH. The default here is right only for
// a plain single-checkout local dev setup (same as src/db.js's own
// SQLITE_PATH default, under local-only/ for the same reason: something
// created on every run shouldn't need its own .gitignore entry) and wrong
// in production, where AUTH_GATE_LOG_PATH must be set once during the A/B
// migration, same as ACTIVE_SLOT_PATH/WEBGUI_STATIC_PATH.
const LOG_PATH = process.env.AUTH_GATE_LOG_PATH || path.join(__dirname, "..", "local-only", "auth-gate.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// A fresh clone has no local-only/ on disk at all (purely gitignored, no
// tracked placeholder) -- same reasoning as src/db.js's own mkdirSync for
// SQLITE_PATH. Without this, the first-ever appendLine() would silently
// no-op (errors here are swallowed, never crash the app) instead of
// actually logging anything.
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// One JSON object per line -- see /admin/logs for why: it's what makes a
// structured, chat-style rendering possible without scraping free text,
// and it's resilient to multi-arg console.log(a, b, c) calls (joined into
// one message here, before anything's written).
function formatArgs(args) {
  return args
    .map((a) => (typeof a === "string" ? a : require("node:util").inspect(a)))
    .join(" ");
}

function appendLine(level, args) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: formatArgs(args) }) + "\n";
  try {
    let size = 0;
    try {
      size = fs.statSync(LOG_PATH).size;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    // One rotated backup, mirroring the agent's own NSSM AppRotateFiles=1
    // convention. Only the current file is ever read back for display --
    // the backup exists purely to bound disk growth.
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // Never let logging itself take the app down -- same reasoning as
    // every other best-effort write in this codebase (e.g. the mission-
    // agent's own token-save fallback).
  }
}

// Wraps console.log/warn/error once so every existing call site keeps
// working unchanged -- each call still reaches the real stdout/stderr
// (journald, or a devenv shell redirect, unaffected) and now also appends
// a structured line to LOG_PATH. launcher.js is deliberately left out of
// this: its own top comment states a zero-dependency-surface boundary an
// update should never need to cross.
function installConsoleCapture() {
  const original = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  console.log = (...args) => {
    original.log(...args);
    appendLine("log", args);
  };
  console.warn = (...args) => {
    original.warn(...args);
    appendLine("warn", args);
  };
  console.error = (...args) => {
    original.error(...args);
    appendLine("error", args);
  };
  // Step-by-step detail (e.g. src/updateCheck.js's applyUpdate() progress
  // trail) that's noise during normal operation but genuinely useful when
  // something's stuck -- console.debug keeps it out of the plain "log"
  // level, so /admin/logs can hide it behind its own "Verbose" filter
  // instead of mixing it into every other line.
  console.debug = (...args) => {
    original.debug(...args);
    appendLine("debug", args);
  };
}

// Reads the last maxLines of LOG_PATH, parsed. A line that fails to parse
// (pre-existing plain-text content from before this format existed, or a
// hand-edited file) renders as a raw row instead of breaking the page.
function readRecentEntries(maxLines) {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n").filter(Boolean).slice(-maxLines);
  return lines.map((line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.t === "string" && typeof parsed.msg === "string") return parsed;
    } catch {
      // fall through to the raw case below
    }
    return { t: null, level: "raw", msg: line };
  });
}

module.exports = { LOG_PATH, installConsoleCapture, readRecentEntries };
