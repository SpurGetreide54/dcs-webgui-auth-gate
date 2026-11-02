// the a/b self-update system's brain: hourly github polling, ed25519
// manifest verification, and staging a verified release into the
// idle slot, see docs/Why.md#why-is-signed_updatesjson-the-trust-root-instead-of-github-itself

// node built-ins, the tar library, and the db and active-slot modules
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");
const tar = require("tar");
const db = require("./db");
const activeSlot = require("./activeSlot");
const agentClient = require("./agentClient");
const { GITHUB_REPO } = require("./updateConstants");
const { GITHUB_API_BASE, fetchGithub } = require("./githubApi");
const { isVersionGreater } = require("./versionCompare");

// section: constants

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// read this install's own current version from package.json
function getCurrentVersion() {
  return require("../package.json").version;
}

// section: fetching and verifying the signed manifest

// the currently trusted signing key, read fresh from key_state so a
// primary rotation takes effect immediately, see
// docs/Why.md#why-does-verifymanifest-read-key_state-instead-of-a-hardcoded-constant
function getTrustedPublicKey() {
  const row = db.prepare("SELECT primary_public_key_pem FROM key_state WHERE id = 1").get();
  return crypto.createPublicKey(row.primary_public_key_pem);
}

// pull a manifest apart into the signed payload and its signature,
// the one split every signer and verifier of it must agree on
function splitManifestSignature(manifest) {
  const { signature, ...signed } = manifest;
  return { signed, signature };
}

// true if the manifest's signature matches everything else in it,
// secondary is never accepted here, only primary
function verifyManifest(manifest) {
  // the signature covers everything except itself
  const { signed, signature } = splitManifestSignature(manifest);
  if (typeof signature !== "string") return false;
  const message = Buffer.from(JSON.stringify(signed));
  return crypto.verify(null, message, getTrustedPublicKey(), Buffer.from(signature, "hex"));
}

// fetch a url and parse its response as json
async function fetchJson(url) {
  const res = await fetchGithub(url, "dcs-webgui-auth-gate-update-check");
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// fetch the latest release's manifest, refusing one that fails verification
// see docs/Why.md#why-is-fetchverifiedmanifest-always-re-fetched-instead-of-cached
async function fetchVerifiedManifest() {
  const release = await fetchJson(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`);
  const asset = (release.assets || []).find((a) => a.name === "signed_updates.json");
  if (!asset) throw new Error("Latest GitHub release has no signed_updates.json asset.");
  const manifest = await fetchJson(asset.browser_download_url);
  if (!verifyManifest(manifest)) throw new Error("signed_updates.json failed signature verification.");
  return manifest;
}

// find one artifact's download entry in a verified manifest
function findDownload(manifest, artifact) {
  const entry = (manifest.downloads || []).find((d) => d.artifact === artifact);
  if (!entry) throw new Error(`Manifest has no download entry for "${artifact}".`);
  return entry;
}

// download a file and confirm its sha256 matches before trusting it
async function downloadAndVerify(url, sha256, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  // hash each chunk as it flows through, instead of re-reading the
  // whole file back off disk once the write finishes
  const hash = crypto.createHash("sha256");
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), hasher, fs.createWriteStream(destPath));
  const actual = hash.digest("hex");
  if (actual !== sha256) throw new Error(`${url}: sha256 mismatch (expected ${sha256}, got ${actual}).`);
}

// section: update_state, the display-only cache of the last check

// read the single update_state row
function getUpdateState() {
  return db.prepare("SELECT * FROM update_state WHERE id = 1").get();
}

// write the single update_state row
function setUpdateState({ lastCheckedAt, availableVersion, changelogUrl, needsServiceUpdate }) {
  db.prepare(
    `UPDATE update_state SET last_checked_at = ?, available_version = ?, changelog_url = ?, needs_service_update = ? WHERE id = 1`
  ).run(lastCheckedAt, availableVersion, changelogUrl, needsServiceUpdate ? 1 : 0);
}

// records that checkForUpdate completed without throwing, read by
// isUpdateCheckStale instead of last_checked_at, which also updates
// on a failed attempt
function recordUpdateCheckSucceeded(at) {
  db.prepare("UPDATE update_state SET last_succeeded_at = ? WHERE id = 1").run(at);
}

// records only that an attempt happened, leaving any already-found
// pending update in place instead of erasing it on a transient failure
function setLastCheckedAt(at) {
  db.prepare("UPDATE update_state SET last_checked_at = ? WHERE id = 1").run(at);
}

// the hourly poll, also callable directly for an admin's "check now"
// see docs/Why.md#why-does-checkforupdate-re-throw-its-own-errors
async function checkForUpdate() {
  const now = new Date().toISOString();
  try {
    const manifest = await fetchVerifiedManifest();
    const hasUpdate = isVersionGreater(manifest.version, getCurrentVersion());
    if (isVersionGreater(getCurrentVersion(), manifest.version)) {
      console.warn(`Offered version ${manifest.version} is not newer than the current ${getCurrentVersion()}, ignoring.`);
    }
    setUpdateState({
      lastCheckedAt: now,
      availableVersion: hasUpdate ? manifest.version : null,
      changelogUrl: hasUpdate ? manifest.changelog_url : null,
      needsServiceUpdate: hasUpdate ? Boolean(manifest.needs_service_update) : false,
    });
    recordUpdateCheckSucceeded(now);
    return hasUpdate;
  } catch (err) {
    setLastCheckedAt(now);
    throw err;
  }
}

// section: the cooldown guard against two overlapping applyUpdate() runs

// see docs/Why.md#why-does-update_state-track-when-an-update-was-last-triggered
const UPDATE_COOLDOWN_MS = 60 * 1000;

// record that an update was just triggered, starting the cooldown
function recordUpdateTriggered() {
  db.prepare("UPDATE update_state SET update_triggered_at = ? WHERE id = 1").run(new Date().toISOString());
}

// null if no cooldown is active, otherwise the Date it lifts at
function getUpdateCooldownUntil() {
  const { update_triggered_at } = getUpdateState();
  if (!update_triggered_at) return null;
  const until = new Date(update_triggered_at).getTime() + UPDATE_COOLDOWN_MS;
  return until > Date.now() ? new Date(until) : null;
}

// true only while this process's own applyUpdate() is still running,
// catches a second click past the 60s db cooldown if the first run
// is genuinely still in flight, see docs/Why.md#why-does-update_state-track-when-an-update-was-last-triggered
let updateInFlight = false;

// read-only check of the flag above, exposed so callers can tell
function isUpdateInFlight() {
  return updateInFlight;
}

// start the hourly background poll, swallowing (not throwing) its errors
function startHourlyCheck() {
  const swallowed = () => checkForUpdate().catch((err) => console.warn(`Update check failed: ${err.message}`));
  swallowed();
  const timer = setInterval(swallowed, CHECK_INTERVAL_MS);
  // never keeps the process alive on its own
  timer.unref();
  return timer;
}

// section: staging a downloaded release into the idle slot

// extract into a scratch dir then atomic-rename into place, same
// proven shape as server.js's webgui-sync, so a bad download or a
// mid-extract failure never leaves the idle slot half-written
async function stageAuthGateSlot(archivePath, slotDir) {
  const tmpDir = `${slotDir}.update-tmp-${Date.now()}`;
  const hadExisting = fs.existsSync(slotDir);
  const backupDir = `${slotDir}.update-backup-${Date.now()}`;
  try {
    await fsp.mkdir(tmpDir, { recursive: true });
    await tar.x({ file: archivePath, cwd: tmpDir });
    await fsp.access(path.join(tmpDir, "package.json"));

    if (hadExisting) await fsp.rename(slotDir, backupDir);
    try {
      await fsp.rename(tmpDir, slotDir);
    } catch (renameErr) {
      // the rename into place failed, put the old slot back
      if (hadExisting) await fsp.rename(backupDir, slotDir);
      throw renameErr;
    }
    if (hadExisting) await fsp.rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

// section: relaying the agent's own update through this process

// see docs/Why.md#why-is-the-agent-relay-timeout-only-60-seconds
const AGENT_RELAY_TIMEOUT_MS = Number(process.env.AGENT_RELAY_TIMEOUT_MS) || 60 * 1000;

// upload and commit the agent's new build over the internal channel,
// forwarding the manifest's own signature and the key-rotation history
// so the agent can verify authenticity itself instead of trusting
// whatever bytes a token holder sends
// see docs/Why.md#why-does-the-auth-gate-relay-the-agents-update
async function relayAgentUpdate(archivePath, manifest) {
  if (!agentClient.isConfigured()) throw new Error("Mission agent is not configured; cannot relay its update.");
  const fileBuffer = await fsp.readFile(archivePath);
  console.debug(`Update: uploading agent build to the mission agent (${fileBuffer.length} bytes)...`);

  const { signed, signature } = splitManifestSignature(manifest);
  // required here, not at module load, to avoid a circular require --
  // keyRotation.js itself requires this module for CHECK_INTERVAL_MS
  const keyRotation = require("./keyRotation");
  const history = await keyRotation.fetchKeyStateHistory().catch((err) => {
    console.warn(`Could not fetch key-state history to relay to the agent: ${err.message}`);
    return null;
  });

  const headers = {
    "Content-Type": "application/octet-stream",
    "X-Manifest-Signed": JSON.stringify(signed),
    "X-Manifest-Signature": signature,
  };
  // branch: at least one rotation has ever been published
  if (history) headers["X-Key-State-History"] = JSON.stringify(history);

  const stageRes = await agentClient.agentFetch("/self-update/stage", {
    method: "POST",
    headers,
    body: fileBuffer,
    timeoutMs: AGENT_RELAY_TIMEOUT_MS,
  });
  if (!stageRes.ok) throw new Error(`Agent rejected the staged update: ${await stageRes.text().catch(() => stageRes.status)}`);
  console.debug("Update: agent build staged, committing...");

  const commitRes = await agentClient.agentFetch("/self-update/commit", { method: "POST", timeoutMs: AGENT_RELAY_TIMEOUT_MS });
  if (!commitRes.ok) throw new Error(`Agent rejected committing the staged update: ${await commitRes.text().catch(() => commitRes.status)}`);
  console.debug("Update: agent committed and is restarting.");
}

// section: the whole update, start to finish

// fail fast, before touching the agent or downloading anything, if
// the active-slot file (or its directory, on a very first update)
// isn't writable -- a late failure here would leave the gate and
// the agent on different versions
function assertActiveSlotWritable() {
  try {
    fs.accessSync(activeSlot.ACTIVE_SLOT_PATH, fs.constants.W_OK);
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`Cannot write the active-slot file: ${err.message}`);
    // no slot file yet (very first update); its directory must be
    // writable instead, since writeActiveSlot will create the file
    try {
      fs.accessSync(path.dirname(activeSlot.ACTIVE_SLOT_PATH), fs.constants.W_OK);
    } catch (dirErr) {
      throw new Error(`Cannot create the active-slot file: ${dirErr.message}`);
    }
  }
}

// re-verify, download both artifacts, stage the auth-gate, relay and
// commit the agent's build, flip the pointer, then exit for the
// supervisor to restart into the new slot
async function applyUpdate() {
  // cleared in the finally below; on success process.exit() kills the
  // process first, so clearing it there never actually matters
  updateInFlight = true;
  try {
    console.debug(`Update: starting applyUpdate()...`);
    assertActiveSlotWritable();
    const manifest = await fetchVerifiedManifest();
    console.debug(`Update: verified manifest for version ${manifest.version}.`);
    // refuses a downgrade the same way checkForUpdate does, the only
    // check that actually gates an install, regardless of which path
    // triggered it, see docs/Why.md#why-does-checkforupdate-reject-a-lower-or-equal-version
    if (!isVersionGreater(manifest.version, getCurrentVersion())) {
      throw new Error(`Offered version ${manifest.version} is not newer than the current ${getCurrentVersion()}, refusing to install.`);
    }
    const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dcs-auth-gate-update-"));
    try {
      const authGateDownload = findDownload(manifest, "auth-gate");
      const authGateArchive = path.join(scratchDir, "auth-gate.tar.gz");
      await downloadAndVerify(authGateDownload.url, authGateDownload.sha256, authGateArchive);
      console.debug("Update: downloaded and verified the auth-gate archive.");

      const idleSlot = activeSlot.otherSlot(activeSlot.readActiveSlot());
      // __dirname is releases/<active-slot>/src, three levels up is the
      // shared top-level app root
      const appRoot = path.join(__dirname, "..", "..", "..");
      const slotDir = path.join(appRoot, "releases", idleSlot);
      await stageAuthGateSlot(authGateArchive, slotDir);
      console.debug(`Update: staged into slot ${idleSlot}.`);
      // node_modules is already complete and correct here, extracted
      // straight from the archive's own npm ci, see
      // docs/Why.md#why-doesnt-applyupdate-run-npm-install-in-the-new-slot

      const agentDownload = findDownload(manifest, "agent");
      const agentExe = path.join(scratchDir, "agent.exe");
      await downloadAndVerify(agentDownload.url, agentDownload.sha256, agentExe);
      console.debug("Update: downloaded and verified the agent build.");
      await relayAgentUpdate(agentExe, manifest);

      activeSlot.writeActiveSlot(idleSlot);
      setUpdateState({
        lastCheckedAt: new Date().toISOString(),
        availableVersion: null,
        changelogUrl: null,
        needsServiceUpdate: Boolean(manifest.needs_service_update),
      });
      // a fresh update with no new rollback is itself the "resolved"
      // signal, required here (not at module load) to avoid a circular
      // require with diagnostics.js, see docs/Why.md#why-does-diagnostics-mirror-updatecheckjss-own-shape
      require("./diagnostics").clearRollback();
      console.log(`Update: flipped active slot to ${idleSlot}. Exiting for the supervisor to restart into it.`);
    } finally {
      await fsp.rm(scratchDir, { recursive: true, force: true });
    }

    // a clean exit(0), not exit(1)
    // see docs/Why.md#why-does-applyupdate-exit0-instead-of-exit1
    process.exitCode = 0;
    process.exit(0);
  } finally {
    updateInFlight = false;
  }
}

// expose every function another module needs, plus the two constants
// tests and src/updateCheck.js's own callers reach for
module.exports = {
  GITHUB_REPO,
  CHECK_INTERVAL_MS,
  getCurrentVersion,
  isVersionGreater,
  downloadAndVerify,
  verifyManifest,
  fetchVerifiedManifest,
  checkForUpdate,
  startHourlyCheck,
  relayAgentUpdate,
  applyUpdate,
  getUpdateState,
  recordUpdateTriggered,
  getUpdateCooldownUntil,
  isUpdateInFlight,
};
