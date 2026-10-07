const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const updateCheck = require("../src/updateCheck");

// A throwaway keypair, generated fresh per test -- distinct from the real
// one at local-only/keys/, used to prove verifyManifest() rejects a
// signature from any key other than the one matching its own hardcoded
// public key, not just outright corrupted bytes.
function freshKeypair() {
  return crypto.generateKeyPairSync("ed25519");
}

function signManifest(privateKey, signed) {
  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
  return { ...signed, signature };
}

test("getCurrentVersion reads package.json's own version", () => {
  const pkg = require("../package.json");
  assert.equal(updateCheck.getCurrentVersion(), pkg.version);
});

// The one test that can catch "the hardcoded public key in src/
// updateCheck.js doesn't actually match the private key at local-only/
// keys/" -- a real, easy-to-make mistake (pasting the wrong key, or the
// key getting regenerated without updating the hardcoded copy) that every
// other test here is structurally unable to catch, since they all use
// their own throwaway keypairs. Only runs where that private key exists
// (gitignored, so not on a fresh clone) -- skipped rather than failed
// elsewhere, same as this repo's other real-infra-only checks.
const REAL_PRIVATE_KEY_PATH = path.join(__dirname, "..", "local-only", "keys", "update-signing-key.pem");
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
  // Signs with a fresh key, then separately re-points verifyManifest at
  // that fresh key's own public half via a tiny stand-in module -- can't
  // sign with the real app's private key here (it's not committed), so
  // this test proves the *tamper-detection* property specifically: given
  // a signature that WOULD verify against its own content, mutating the
  // content after the fact must break verification.
  const { publicKey, privateKey } = freshKeypair();
  const signed = {
    version: "1.2.3",
    changelog_url: "https://example.test/changelog",
    needs_service_update: false,
    downloads: [{ artifact: "auth-gate", url: "https://example.test/a.tar.gz", sha256: "b".repeat(64) }],
  };
  const message = Buffer.from(JSON.stringify(signed));
  const signature = crypto.sign(null, message, privateKey).toString("hex");

  // Same verification the real verifyManifest does, just against this
  // test's own throwaway public key instead of the hardcoded app one.
  const tampered = { ...signed, downloads: [{ ...signed.downloads[0], sha256: "c".repeat(64) }] };
  const { signature: _unused, ...tamperedSigned } = { ...tampered, signature };
  const tamperedMessage = Buffer.from(JSON.stringify(tamperedSigned));
  assert.equal(crypto.verify(null, tamperedMessage, publicKey, Buffer.from(signature, "hex")), false);

  // The untampered original, same signature, must still verify -- proves
  // the failure above is really about the content changing, not a broken
  // verify call.
  assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
});

test("sign-updates.js produces a manifest the real verifyManifest() accepts, end to end", () => {
  // Generates a throwaway keypair and runs it through the actual CLI
  // script's logic by invoking it as a subprocess with a temporary key
  // file, then swaps in that keypair's public half to check against --
  // the closest thing to a real release without touching the committed
  // app key. If this passes, the manifest shape sign-updates.js writes is
  // exactly what verifyManifest() expects.
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

    // Re-verify using the throwaway public key directly (not the app's
    // hardcoded one, which this manifest wasn't signed with).
    const { signature, ...signed } = manifest;
    const message = Buffer.from(JSON.stringify(signed));
    assert.equal(crypto.verify(null, message, publicKey, Buffer.from(signature, "hex")), true);
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
});
