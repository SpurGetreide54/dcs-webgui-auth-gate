const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "release", "archive-old-release.sh");

function runArchiveScript(releaseDir, archiveDir) {
  return execFileSync("sh", [SCRIPT_PATH], {
    env: { ...process.env, ARCHIVE_OLD_RELEASE_RELEASE_DIR: releaseDir, ARCHIVE_OLD_RELEASE_ARCHIVE_DIR: archiveDir },
    encoding: "utf8",
  });
}

test("archive-old-release.sh leaves a pending key_state.draft.json in place and archives everything else", () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-old-release-test-release-"));
  const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-old-release-test-archive-"));
  try {
    fs.writeFileSync(path.join(releaseDir, "signed_updates.json"), JSON.stringify({ version: "1.2.3" }));
    fs.writeFileSync(path.join(releaseDir, "key_state.draft.json"), JSON.stringify({ draft: true }));
    fs.mkdirSync(path.join(releaseDir, "auth-gate"));
    fs.writeFileSync(path.join(releaseDir, "auth-gate", "placeholder"), "");

    runArchiveScript(releaseDir, archiveDir);

    assert.equal(
      fs.existsSync(path.join(releaseDir, "key_state.draft.json")),
      true,
      "a pending rotation draft must survive a release cut, not get swept into the archive"
    );
    assert.equal(
      fs.existsSync(path.join(archiveDir, "1.2.3", "key_state.draft.json")),
      false,
      "the draft must not appear in the archived version's own directory either"
    );
    assert.equal(fs.existsSync(path.join(archiveDir, "1.2.3", "signed_updates.json")), true, "the manifest must still be archived");
    assert.equal(
      fs.existsSync(path.join(archiveDir, "1.2.3", "auth-gate", "placeholder")),
      true,
      "everything else must still move into the version archive"
    );
    assert.equal(fs.existsSync(path.join(releaseDir, "signed_updates.json")), false, "the archived manifest must not remain in the release dir");
    assert.equal(fs.existsSync(path.join(releaseDir, "auth-gate")), true, "a fresh empty auth-gate/ must be recreated for the next build");
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
    fs.rmSync(archiveDir, { recursive: true, force: true });
  }
});
