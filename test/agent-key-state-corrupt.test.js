const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-state-corrupt-saved-games-"));
const keyStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-state-corrupt-"));
const keyStateFile = path.join(keyStateDir, "agent-key-state.json");

fs.writeFileSync(keyStateFile, "{not valid json");

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = "agent-key-state-corrupt-test-token";
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_KEY_STATE_FILE = keyStateFile;

const originalWarn = console.warn;
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));

require("../src/agent");
const { PRIMARY_PUBLIC_KEY_PEM, SECONDARY_PUBLIC_KEY_PEM } = require("../src/keyRotationConstants");

console.warn = originalWarn;

test.after(() => {
  fs.rmSync(savedGamesRoot, { recursive: true, force: true });
  fs.rmSync(keyStateDir, { recursive: true, force: true });
});

test("a corrupt key-state file is reseeded from the built-in keys, with a warning, instead of crashing the agent", () => {
  assert.ok(warnings.some((w) => w.includes(keyStateFile)), "expected a warning naming the unreadable file");
  const reseeded = JSON.parse(fs.readFileSync(keyStateFile, "utf8"));
  assert.equal(reseeded.primary_public_key_pem, PRIMARY_PUBLIC_KEY_PEM);
  assert.equal(reseeded.secondary_public_key_pem, SECONDARY_PUBLIC_KEY_PEM);
});
