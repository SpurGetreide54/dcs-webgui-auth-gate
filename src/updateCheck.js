// The A/B self-update system's brain: hourly GitHub polling, Ed25519
// manifest verification, and staging a verified release into the idle
// slot. launcher.js and src/activeSlot.js stay outside this file on
// purpose -- this is the business logic they're kept separate from.
//
// Trust root: signed_updates.json, attached as a release asset on GitHub,
// signed with the Ed25519 private key at local-only/keys/update-signing-
// key.pem (gitignored, never committed -- see scripts/release/sign-
// updates.js). Only the public key below ships with the app. A compromised
// GitHub account or a MITM'd download can serve bytes, but can't produce a
// manifest this code will accept without that private key.

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

const GITHUB_REPO = "SpurGetreide54/dcs-webgui-auth-gate";
// Overridable so tests can point this at a local dummy server instead of
// the real GitHub API, same as MISSION_AGENT_URL/WEBGUI_CONTROL_PORT are
// already configured elsewhere in this app.
const GITHUB_API_BASE = process.env.GITHUB_API_BASE_OVERRIDE || "https://api.github.com";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const MISSION_AGENT_URL = process.env.MISSION_AGENT_URL;
const MISSION_AGENT_TOKEN = process.env.MISSION_AGENT_TOKEN;

// Public half of the keypair generated for this project. The private key
// never leaves local-only/keys/ on the releaser's own machine.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA1W0lrUvQR5XTlepPzmtWsz2XYkIetU/dA7n79B1bTAY=
-----END PUBLIC KEY-----
`;
const PUBLIC_KEY = crypto.createPublicKey(PUBLIC_KEY_PEM);

function getCurrentVersion() {
  return require("../package.json").version;
}

// The manifest's own `signature` field is removed before verifying --
// it's a signature over everything else, not over itself. sign-updates.js
// produces exactly this shape in reverse.
function verifyManifest(manifest) {
  const { signature, ...signed } = manifest;
  if (typeof signature !== "string") return false;
  const message = Buffer.from(JSON.stringify(signed));
  return crypto.verify(null, message, PUBLIC_KEY, Buffer.from(signature, "hex"));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "dcs-webgui-auth-gate-update-check" } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// Verified, not just fetched -- callers never see an unsigned or
// tampered manifest. Re-fetched fresh every time (checkForUpdate and
// applyUpdate both call this), never trusted from a cache: the DB's own
// cached fields exist for display only, not as something to act on.
async function fetchVerifiedManifest() {
  const release = await fetchJson(`${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/latest`);
  const asset = (release.assets || []).find((a) => a.name === "signed_updates.json");
  if (!asset) throw new Error("Latest GitHub release has no signed_updates.json asset.");
  const manifest = await fetchJson(asset.browser_download_url);
  if (!verifyManifest(manifest)) throw new Error("signed_updates.json failed signature verification.");
  return manifest;
}

function findDownload(manifest, artifact) {
  const entry = (manifest.downloads || []).find((d) => d.artifact === artifact);
  if (!entry) throw new Error(`Manifest has no download entry for "${artifact}".`);
  return entry;
}

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

function getUpdateState() {
  return db.prepare("SELECT * FROM update_state WHERE id = 1").get();
}

function setUpdateState({ lastCheckedAt, availableVersion, changelogUrl, needsServiceUpdate }) {
  db.prepare(
    `UPDATE update_state SET last_checked_at = ?, available_version = ?, changelog_url = ?, needs_service_update = ? WHERE id = 1`
  ).run(lastCheckedAt, availableVersion, changelogUrl, needsServiceUpdate ? 1 : 0);
}

// The hourly poll (also callable directly for an admin-triggered "check
// now"). Only ever updates update_state for display -- never stages or
// applies anything itself. That's applyUpdate()'s job, run explicitly by
// a site admin clicking the update button.
//
// A failure (network, bad signature, GitHub down) still records that a
// check was attempted, but is re-thrown rather than swallowed -- an admin
// who just clicked "check now" needs to know the check itself failed,
// not see a false "you're up to date". startHourlyCheck()'s own silent
// background-poll behavior comes from catching it there instead.
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

function startHourlyCheck() {
  const swallowed = () => checkForUpdate().catch((err) => console.warn(`Update check failed: ${err.message}`));
  swallowed();
  const timer = setInterval(swallowed, CHECK_INTERVAL_MS);
  timer.unref(); // never keeps the process alive on its own
  return timer;
}

// Extract-into-scratch-then-atomic-rename, same proven shape as
// server.js's webgui-sync: a bad download or a mid-extract failure must
// never leave the idle slot half-written, since the next flip would load
// straight into that mess.
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
      if (hadExisting) await fsp.rename(backupDir, slotDir);
      throw renameErr;
    }
    if (hadExisting) await fsp.rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

function runNpmInstall(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["install", "--omit=dev"], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited with code ${code}`))));
  });
}

// How long the agent relay below will wait for each of its two requests
// before giving up. Without this, a stalled upload to a real remote host
// (unlike this function's own local/CI test coverage, which never crosses
// a real network) can hang indefinitely with no error at all -- the
// in-flight applyUpdate() call just sits there forever, never reaching
// its own success or failure path, and never logging anything either way.
// Kept short deliberately: the auth-gate and mission-agent only ever talk
// over the internal network between the control-panel VM and the DCS
// host (see SETUP.md), never the open internet, so even the ~96MB agent
// build should move in single-digit seconds. Anything still running
// after a minute already means something's broken, not just slow --
// failing fast beats an admin waiting minutes to find that out.
const AGENT_RELAY_TIMEOUT_MS = Number(process.env.AGENT_RELAY_TIMEOUT_MS) || 60 * 1000;

// Relays the agent's new build through the existing internal auth-gate <->
// agent channel -- the agent has no internet access of its own by design
// (kept off the host's internet-facing side, see SETUP.md), so the
// auth-gate is the one that reaches GitHub and hands the bytes onward.
async function relayAgentUpdate(archivePath, sha256) {
  if (!MISSION_AGENT_URL || !MISSION_AGENT_TOKEN) throw new Error("Mission agent is not configured; cannot relay its update.");
  const fileBuffer = await fsp.readFile(archivePath);
  console.log(`Update: uploading agent build to the mission agent (${fileBuffer.length} bytes)...`);
  const stageRes = await fetch(new URL("/self-update/stage", MISSION_AGENT_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}`, "Content-Type": "application/octet-stream", "X-Sha256": sha256 },
    body: fileBuffer,
    signal: AbortSignal.timeout(AGENT_RELAY_TIMEOUT_MS),
  });
  if (!stageRes.ok) throw new Error(`Agent rejected the staged update: ${await stageRes.text().catch(() => stageRes.status)}`);
  console.log("Update: agent build staged, committing...");

  const commitRes = await fetch(new URL("/self-update/commit", MISSION_AGENT_URL), {
    method: "POST",
    headers: { Authorization: `Bearer ${MISSION_AGENT_TOKEN}` },
    signal: AbortSignal.timeout(AGENT_RELAY_TIMEOUT_MS),
  });
  if (!commitRes.ok) throw new Error(`Agent rejected committing the staged update: ${await commitRes.text().catch(() => commitRes.status)}`);
  console.log("Update: agent committed and is restarting.");
}

// The whole update, start to finish: re-verify, download both artifacts,
// stage the auth-gate into the idle slot, relay+commit the agent's build,
// flip the pointer, then deliberately exit non-zero. Restart=on-failure
// (the systemd unit's existing policy, unchanged by the A/B migration)
// is what actually brings the new slot up -- this process doesn't call
// systemctl itself, since the service account has no sudo for that.
async function applyUpdate() {
  console.log(`Update: starting applyUpdate()...`);
  const manifest = await fetchVerifiedManifest();
  console.log(`Update: verified manifest for version ${manifest.version}.`);
  const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dcs-auth-gate-update-"));
  try {
    const authGateDownload = findDownload(manifest, "auth-gate");
    const authGateArchive = path.join(scratchDir, "auth-gate.tar.gz");
    await downloadAndVerify(authGateDownload.url, authGateDownload.sha256, authGateArchive);
    console.log("Update: downloaded and verified the auth-gate archive.");

    const idleSlot = activeSlot.otherSlot(activeSlot.readActiveSlot());
    // __dirname here is releases/<active-slot>/src -- three levels up is
    // the shared top-level app root (releases/ itself is one level above
    // the active slot's own root, which is one level above src/).
    const appRoot = path.join(__dirname, "..", "..", "..");
    const slotDir = path.join(appRoot, "releases", idleSlot);
    await stageAuthGateSlot(authGateArchive, slotDir);
    console.log(`Update: staged into slot ${idleSlot}, running npm install...`);
    await runNpmInstall(slotDir);
    console.log("Update: npm install finished.");

    const agentDownload = findDownload(manifest, "agent");
    const agentExe = path.join(scratchDir, "agent.exe");
    await downloadAndVerify(agentDownload.url, agentDownload.sha256, agentExe);
    console.log("Update: downloaded and verified the agent build.");
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

  process.exitCode = 1;
  process.exit(1);
}

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
};
