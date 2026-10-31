// node's own filesystem and path modules
const fs = require("node:fs");
const path = require("node:path");

// where the structured log file lives, overridden in production via
// auth_gate_log_path (or auth_gate_state_dir) in .env, same reasoning
// as activeSlot.js's path
// see docs/Why.md#why-does-the-log-path-default-to-local-only
const { AUTH_GATE_LOG_PATH: LOG_PATH } = require("./stateDir");
// the file rotates once it would grow past this size
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// a fresh clone has no local-only/ on disk at all, so make sure the
// directory exists before the first ever log line gets written
fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });

// join a console call's arguments into one line of readable text
// see docs/Why.md#why-is-each-log-line-a-single-json-object
function formatArgs(args) {
  return args
    .map((a) => (typeof a === "string" ? a : require("node:util").inspect(a)))
    .join(" ");
}

// append one structured log line, rotating the file first if it's full
function appendLine(level, args) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: formatArgs(args) }) + "\n";
  try {
    let size = 0;
    try {
      size = fs.statSync(LOG_PATH).size;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    // one rotated backup, same convention as the agent's own nssm
    // approtatefiles=1, kept purely to bound disk growth
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    // never let logging itself take the app down
  }
}

// wrap console.log/warn/error/debug so every existing call site keeps
// working unchanged, now also appending a line to log_path
// launcher.js is deliberately left out, see its own zero-dependency rule
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
  // kept at its own level so /admin/logs can hide step-by-step detail
  // behind a "verbose" filter instead of mixing it into every line
  console.debug = (...args) => {
    original.debug(...args);
    appendLine("debug", args);
  };
}

// read back the last maxLines of the log file, parsed
// a line that fails to parse (old plain-text content, a hand edit)
// renders as a raw row instead of breaking the page
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

// expose the path and both public functions to callers
module.exports = { LOG_PATH, installConsoleCapture, readRecentEntries };
