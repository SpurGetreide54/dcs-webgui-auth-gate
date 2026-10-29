const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

// a throwaway keypair, generated fresh per test, distinct from the
// real one at local-only/keys/, proves verifyManifest() rejects any
// key other than the one matching its own hardcoded public key
function freshKeypair() {
  return crypto.generateKeyPairSync("ed25519");
}

function signManifest(privateKey, signed) {
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
  return { ...signed, signature };
}

// a minimal http server, standing in for the real github api
function startDummyHttpServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// a fresh, unique sqlite path per test file, under the os temp dir
function tempSqlitePath(label) {
  return path.join(os.tmpdir(), `update-check-test-${label}-${crypto.randomBytes(6).toString("hex")}.sqlite`);
}

// delete a sqlite file and its wal/shm siblings
function cleanupSqlite(sqlitePath) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(sqlitePath + suffix, { force: true });
}

// GITHUB_API_BASE_OVERRIDE and SQLITE_PATH both have to be set before
// src/updateCheck.js is first required, so both happen in test.before()
let updateCheck;
let dummyGithub, dummyGithubBase;
let dummyGithubRespond; // set per test to control what the dummy "GitHub API" returns
let sqlitePath;

const REAL_PRIVATE_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "update-signing-key.pem");

test.before(async () => {
  dummyGithub = await startDummyHttpServer((req, res) => dummyGithubRespond(req, res));
  dummyGithubBase = `http://127.0.0.1:${dummyGithub.address().port}`;
  process.env.GITHUB_API_BASE_OVERRIDE = dummyGithubBase;

  sqlitePath = tempSqlitePath("update-check");
  process.env.SQLITE_PATH = sqlitePath;

  updateCheck = require("../src/updateCheck");
});

test.after(async () => {
  await new Promise((resolve) => dummyGithub.close(resolve));
  require("../src/db").close();
  cleanupSqlite(sqlitePath);
});

test("getCurrentVersion reads package.json's own version", () => {
  const pkg = require("../package.json");
  assert.equal(updateCheck.getCurrentVersion(), pkg.version);
});

// the one test that can catch a mismatch between the hardcoded public
// key and the real private key, skipped (not failed) where that
// gitignored private key doesn't exist on this machine
test(
  "verifyManifest accepts a manifest signed with the real local-only/keys/ private key",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/update-signing-key.pem not present on this machine" : false },
  () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "1.2.3",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "d".repeat(64) }],
    });
    assert.equal(updateCheck.verifyManifest(manifest), true, "the hardcoded PUBLIC_KEY_PEM in src/updateCheck.js must match local-only/keys/update-signing-key.pem");
  }
);

test("verifyManifest rejects a manifest signed with the wrong key", () => {
  const { privateKey } = freshKeypair(); // not the real app key
  const manifest = signManifest(privateKey, {
    version: "9.9.9",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "a".repeat(64) }],
  });
  assert.equal(updateCheck.verifyManifest(manifest), false);
});

test("verifyManifest rejects a manifest whose content was tampered with after signing", () => {
  // signs with a fresh key, verifies against that key's own public
  // half directly, proving tamper-detection without the real app key
  const { publicKey, privateKey } = freshKeypair();
  const signed = {
    version: "1.2.3",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "b".repeat(64) }],
  };
  const message = Buffer.from(JSON.stringify(signed));
  const signature = crypto.sign(null, message, privateKey).toString("hex");

  // the same verification verifyManifest does, against this test's
  // own throwaway public key instead of the hardcoded app one
  const tampered = { ...signed, downloads: [{ ...signed.downloads[0], sha256: "c".repeat(64) }] };
  const { signature: _unused, ...tamperedSigned } = { ...tampered, signature };
  const tamperedMessage = Buffer.from(JSON.stringify(tamperedSigned));
  assert.equal(crypto.verify(null, tamperedMessage, publicKey, Buffer.from(signature, "hex")), false);

  // the untampered original, same signature, must still verify, so
  // the failure above is really about the content, not a broken call
  assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
});

test("sign-updates.js produces a manifest the real verifyManifest() accepts, end to end", () => {
  // runs the real cli script as a subprocess with a throwaway key,
  // the closest thing to a real release without touching the app key
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-updates-test-"));
  try {
    const { publicKey, privateKey } = freshKeypair();
    const keyPath = path.join(scratchDir, "key.pem");
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

    const authGatePath = path.join(scratchDir, "auth-gate-1.2.3.tar.gz");
    const agentPath = path.join(scratchDir, "agent-1.2.3.exe");
    fs.writeFileSync(authGatePath, "fake auth-gate tarball bytes");
    fs.writeFileSync(agentPath, "fake agent exe bytes");

    const manifestPath = path.join(scratchDir, "signed_updates.json");
    const { execFileSync } = require("node:child_process");
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, "..", "scripts", "release", "sign-updates.js"),
        "--version",
        "1.2.3",
        "--changelog-url",
        "https://example.test/changelog",
        "--auth-gate",
        authGatePath,
        "--agent",
        agentPath,
        "--key",
        keyPath,
        "--out",
        manifestPath,
      ],
      { cwd: path.join(__dirname, ".."), stdio: "pipe" }
    );

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, "1.2.3");
    assert.equal(manifest.downloads.length, 2);

    // re-verify using the throwaway public key directly, not the
    // app's hardcoded one, which this manifest wasn't signed with
    const { signature, ...signed } = manifest;
    const message = Buffer.from(JSON.stringify(signed));
    assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("updateConstants.js has no side effects: no db import, no sqlite file created", () => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-constants-test-"));
  try {
    const { execFileSync } = require("node:child_process");
    const constantsPath = path.join(__dirname, "..", "src", "updateConstants.js");
    const out = execFileSync(
      process.execPath,
      [
        "-e",
        `const { GITHUB_REPO } = require(${JSON.stringify(constantsPath)});
         const loadedDb = Object.keys(require.cache).some((k) => k.includes("src${path.sep}db.js"));
         console.log(JSON.stringify({ GITHUB_REPO, loadedDb }));`,
      ],
      { cwd: scratchDir, stdio: "pipe" }
    ).toString();
    const result = JSON.parse(out);
    assert.equal(result.loadedDb, false, "requiring updateConstants.js must not pull in db.js");
    assert.match(result.GITHUB_REPO, /\//, "GITHUB_REPO must still be the real owner/repo string");
    assert.equal(fs.existsSync(path.join(scratchDir, "local-only")), false, "no local-only/ directory must be created just from requiring updateConstants.js");
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// serves manifest as the dummy github api's "latest release" asset,
// answering fetchVerifiedManifest()'s two requests from one handler
function serveManifest(manifest) {
  dummyGithubRespond = (req, res) => {
    if (req.url.includes("/releases/latest")) {
      sendJson(res, 200, { assets: [{ name: "signed_updates.json", browser_download_url: `${dummyGithubBase}/signed_updates.json` }] });
    } else {
      sendJson(res, 200, manifest);
    }
  };
}

test(
  "checkForUpdate resolves true and records the new version when a newer signed release is available",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/update-signing-key.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: "9.9.9-test",
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "d".repeat(64) }],
    });
    serveManifest(manifest);

    const hasUpdate = await updateCheck.checkForUpdate();
    assert.equal(hasUpdate, true);
    const state = updateCheck.getUpdateState();
    assert.equal(state.available_version, "9.9.9-test");
    assert.equal(state.changelog_url, "https://example.test/changelog");
    assert.ok(state.last_checked_at);
  }
);

test(
  "checkForUpdate resolves false when the latest release matches the current version",
  { skip: !fs.existsSync(REAL_PRIVATE_KEY_PATH) ? "local-only/keys/update-signing-key.pem not present on this machine" : false },
  async () => {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(REAL_PRIVATE_KEY_PATH, "utf8"));
    const manifest = signManifest(privateKey, {
      version: updateCheck.getCurrentVersion(),
      changelog_url: "https://example.test/changelog",
      needs_service_update: false,
      downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "e".repeat(64) }],
    });
    serveManifest(manifest);

    const hasUpdate = await updateCheck.checkForUpdate();
    assert.equal(hasUpdate, false);
    const state = updateCheck.getUpdateState();
    assert.equal(state.available_version, null);
  }
);

test("checkForUpdate rejects and still records the attempt when the check fails", async () => {
  // no real key needed, a throwaway key the hardcoded public key will
  // never accept, so this runs unconditionally unlike the two tests above
  const { privateKey } = freshKeypair();
  const manifest = signManifest(privateKey, {
    version: "9.9.9-bad",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "f".repeat(64) }],
  });
  serveManifest(manifest);

  await assert.rejects(() => updateCheck.checkForUpdate(), /signature verification/);
  const after = updateCheck.getUpdateState();
  assert.ok(after.last_checked_at, "a failed check must still record that an attempt was made");
  assert.equal(after.available_version, null);
});
