const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const TOKEN = "common-error-handler-test-token";
const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "common-error-handler-saved-games-"));

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = TOKEN;
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;

const app = require("../src/agent");

let server, base;
const originalError = console.error;
const originalWarn = console.warn;
let errorLogs, warnLogs;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.on("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(savedGamesRoot, { recursive: true, force: true });
});

test.beforeEach(() => {
  errorLogs = [];
  warnLogs = [];
  console.error = (...args) => errorLogs.push(args.join(" "));
  console.warn = (...args) => warnLogs.push(args.join(" "));
});

test.afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

test("errorHandler replies 400 with the parser's own message for malformed JSON, logged at warn not error", async () => {
  const res = await fetch(`${base}/self-update/key-state`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: "{not valid json",
  });
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.ok(text.length > 0);
  assert.ok(!errorLogs.some((l) => l.includes("Unhandled error")), "a client error must not log as Unhandled error");
  assert.ok(warnLogs.some((l) => l.includes("Client error")), "a client error must be logged at warn");
});

test("errorHandler replies 413 when a body exceeds the route's own size limit", async () => {
  const oversized = "x".repeat(2 * 1024 * 1024);
  const res = await fetch(`${base}/self-update/key-state`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ history: oversized }),
  });
  assert.equal(res.status, 413);
});
