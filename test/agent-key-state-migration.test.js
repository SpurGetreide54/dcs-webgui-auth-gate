const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const savedGamesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-state-migration-saved-games-"));
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-state-migration-legacy-"));
const pinnedDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-key-state-migration-pinned-"));
const legacyPath = path.join(legacyDir, "agent-key-state.json");
const pinnedPath = path.join(pinnedDir, "agent-key-state.json");

const legacyState = {
  primary_public_key_pem: "legacy-primary-pem",
  primary_rotated_at: "2026-10-01T00:00:00.000Z",
  secondary_public_key_pem: "legacy-secondary-pem",
  secondary_rotated_at: "2026-10-01T00:00:00.000Z",
};
fs.writeFileSync(legacyPath, JSON.stringify(legacyState));

process.env.AGENT_PORT = "0";
process.env.MISSION_AGENT_TOKEN = "agent-key-state-migration-test-token";
process.env.DCS_SAVED_GAMES_ROOT = savedGamesRoot;
process.env.AGENT_KEY_STATE_FILE = pinnedPath;
process.env.AGENT_KEY_STATE_FILE_LEGACY_PATH_OVERRIDE = legacyPath;

require("../src/agent");

test.after(() => {
  fs.rmSync(savedGamesRoot, { recursive: true, force: true });
  fs.rmSync(legacyDir, { recursive: true, force: true });
  fs.rmSync(pinnedDir, { recursive: true, force: true });
});

test("a legacy key-state file at the old slot-relative path is copied into a newly pinned AGENT_KEY_STATE_FILE on startup", () => {
  const migrated = JSON.parse(fs.readFileSync(pinnedPath, "utf8"));
  assert.deepEqual(migrated, legacyState);
});
