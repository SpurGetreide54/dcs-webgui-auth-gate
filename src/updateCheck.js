// The A/B self-update system's brain: hourly GitHub polling and Ed25519
// manifest verification. launcher.js and src/activeSlot.js stay outside
// this file on purpose -- this is the business logic they're kept
// separate from. Staging a verified release into the idle slot is a
// separate concern, added on top of this.
//
// Trust root: signed_updates.json, attached as a release asset on GitHub,
// signed with the Ed25519 private key at local-only/keys/update-signing-
// key.pem (gitignored, never committed -- see scripts/release/sign-
// updates.js). Only the public key below ships with the app. A compromised
// GitHub account or a MITM'd download can serve bytes, but can't produce a
// manifest this code will accept without that private key.

const crypto = require("node:crypto");
const db = require("./db");

const GITHUB_REPO = "SpurGetreide54/dcs-webgui-auth-gate";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

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
// tampered manifest. Re-fetched fresh every time, never trusted from a
// cache: the DB's own cached fields exist for display only, not as
// something to act on.
async function fetchVerifiedManifest() {
  const release = await fetchJson(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  const asset = (release.assets || []).find((a) => a.name === "signed_updates.json");
  if (!asset) throw new Error("Latest GitHub release has no signed_updates.json asset.");
  const manifest = await fetchJson(asset.browser_download_url);
  if (!verifyManifest(manifest)) throw new Error("signed_updates.json failed signature verification.");
  return manifest;
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
// applies anything itself.
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
    console.warn(`Update check failed: ${err.message}`);
    setUpdateState({ lastCheckedAt: now, availableVersion: null, changelogUrl: null, needsServiceUpdate: false });
    return false;
  }
}

function startHourlyCheck() {
  checkForUpdate();
  const timer = setInterval(checkForUpdate, CHECK_INTERVAL_MS);
  timer.unref(); // never keeps the process alive on its own
  return timer;
}

module.exports = {
  GITHUB_REPO,
  PUBLIC_KEY_PEM,
  getCurrentVersion,
  verifyManifest,
  fetchVerifiedManifest,
  checkForUpdate,
  startHourlyCheck,
  getUpdateState,
};
