// the a/b self-update system's brain: hourly github polling, ed25519
// manifest verification, and staging a verified release into the
// idle slot, see docs/Why.md#why-is-signed-updates-json-the-trust-root

// node built-ins, the tar library, and the db and active-slot modules
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const tar = require("tar");
const db = require("./db");
const activeSlot = require("./activeSlot");
const { GITHUB_REPO } = require("./updateConstants");

// section: constants and the trust root

// overridable so tests can point this at a local dummy server instead
// of the real github api
const GITHUB_API_BASE = process.env.GITHUB_API_BASE_OVERRIDE || "https://api.github.com";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;

// public half of this project's keypair, the private half never
// leaves local-only/keys/ on the releaser's own machine
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1W0lrUvQR5XTlepPzmtWsz2XYkIetU/dA7n79B1bTAY=
-----END PUBLIC KEY-----
`;
const PUBLIC_KEY = crypto.createPublicKey(PUBLIC_KEY_PEM);

// read this install's own current version from package.json
function getCurrentVersion() {
  return require("../package.json").version;
}

// section: fetching and verifying the signed manifest

// true if the manifest's signature matches everything else in it
function verifyManifest(manifest) {
  // the signature covers everything except itself
  const { signature, ...signed } = manifest;
  if (typeof signature !== "string") return false;
  const message = Buffer.from(JSON.stringify(signed));
  return crypto.verify(null, message, PUBLIC_KEY, Buffer.from(signature, "hex"));
}

// fetch a url and parse its response as json
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "dcs-webgui-auth-gate-update-check" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// fetch the latest release's manifest, refusing one that fails verification
// see docs/Why.md#why-is-fetchverifiedmanifest-always-re-fetched
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
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  const actual = await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(destPath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
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

// the hourly poll, also callable directly for an admin's "check now"
// see docs/Why.md#why-does-checkforupdate-re-throw-its-own-errors
async function checkForUpdate() {
  const now = new Date().toISOString();
  try {
    const manifest = await fetchVerifiedManifest();
    const hasUpdate = manifest.version !== getCurrentVersion();
    setUpdateState({
      lastCheckedAt: now,
      availableVersion: hasUpdate ? manifest.version : null,
      changelogUrl: hasUpdate ? manifest.changelog_url : null,
      needsServiceUpdate: hasUpdate ? Boolean(manifest.needs_service_update) : false,
    });
    return hasUpdate;
  } catch (err) {
    setUpdateState({ lastCheckedAt: now, availableVersion: null, changelogUrl: null, needsServiceUpdate: false });
    throw err;
  }
}

// section: the cooldown guard against two overlapping applyUpdate() runs

// see docs/Why.md#why-does-update-state-track-when-an-update-was-triggered
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

// install the newly staged slot's production dependencies
function runNpmInstall(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--omit=dev"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
  });
}

// section: relaying the agent's own update through this process

// see docs/Why.md#why-is-the-agent-relay-timeout-only-60-seconds
const AGENT_RELAY_TIMEOUT_MS = Number(process.env.AGENT_RELAY_TIMEOUT_MS) || 60 * 1000;

// upload and commit the agent's new build over the internal channel
// see docs/Why.md#why-does-the-auth-gate-relay-the-agents-update
async function relayAgentUpdate(archivePath, sha256) {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) throw new Error("Mission agent is not configured; cannot relay its update.");
  const fileBuffer = await fsp.readFile(archivePath);
  console.debug(`Update: uploading agent build to the mission agent (${fileBuffer.length} bytes)...`);
  const stageRes = await fetch(new URL("/self-update/stage", MISSION_AGENT_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}`, "Content-Type": "application/octet-stream", "X-Sha256": sha256 },
    body: fileBuffer,
    signal: AbortSignal.timeout(AGENT_RELAY_TIMEOUT_MS),
  });
  if (!stageRes.ok) throw new Error(`Agent rejected the staged update: ${await stageRes.text().catch(() => stageRes.status)}`);
  console.debug("Update: agent build staged, committing...");

  const commitRes = await fetch(new URL("/self-update/commit", MISSION_AGENT_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` },
    signal: AbortSignal.timeout(AGENT_RELAY_TIMEOUT_MS),
  });
  if (!commitRes.ok) throw new Error(`Agent rejected committing the staged update: ${await commitRes.text().catch(() => commitRes.status)}`);
  console.debug("Update: agent committed and is restarting.");
}

// section: the whole update, start to finish

// re-verify, download both artifacts, stage the auth-gate, relay and
// commit the agent's build, flip the pointer, then exit for the
// supervisor to restart into the new slot
async function applyUpdate() {
  console.debug(`Update: starting applyUpdate()...`);
  const manifest = await fetchVerifiedManifest();
  console.debug(`Update: verified manifest for version ${manifest.version}.`);
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
    console.debug(`Update: staged into slot ${idleSlot}, running npm install...`);
    await runNpmInstall(slotDir);
    console.debug("Update: npm install finished.");

    const agentDownload = findDownload(manifest, "agent");
    const agentExe = path.join(scratchDir, "agent.exe");
    await downloadAndVerify(agentDownload.url, agentDownload.sha256, agentExe);
    console.debug("Update: downloaded and verified the agent build.");
    await relayAgentUpdate(agentExe, agentDownload.sha256);

    activeSlot.writeActiveSlot(idleSlot);
    setUpdateState({
      lastCheckedAt: new Date().toISOString(),
      availableVersion: null,
      changelogUrl: null,
      needsServiceUpdate: Boolean(manifest.needs_service_update),
    });
    console.log(`Update: flipped active slot to ${idleSlot}. Exiting for the supervisor to restart into it.`);
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true });
  }

  // a clean exit(0), not exit(1)
  // see docs/Why.md#why-does-applyupdate-exit0-instead-of-exit1
  process.exitCode = 0;
  process.exit(0);
}

// expose every function another module needs, plus the two constants
// tests and src/updateCheck.js's own callers reach for
module.exports = {
  GITHUB_REPO,
  PUBLIC_KEY_PEM,
  getCurrentVersion,
  verifyManifest,
  fetchVerifiedManifest,
  checkForUpdate,
  startHourlyCheck,
  applyUpdate,
  getUpdateState,
  recordUpdateTriggered,
  getUpdateCooldownUntil,
};
