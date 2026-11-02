// the self-update signing-key rotation trust root: primary + secondary
// ed25519 keys, revocable without a new release, checked hourly
// see docs/Why.md#why-is-key-staterotation-a-separate-signed-record

// node's crypto module, and the db and github-repo constant modules
const crypto = require("node:crypto");
const db = require("./db");
const { GITHUB_REPO } = require("./updateConstants");
const { CHECK_INTERVAL_MS } = require("./updateCheck");
const { keyStateMessage } = require("./keyRotationConstants");
const { GITHUB_API_BASE, fetchGithub } = require("./githubApi");

// section: constants

// identifies this module's own requests, distinct from updateCheck.js's
const USER_AGENT = "dcs-webgui-auth-gate-key-state-check";

// fixed release tag the rotation history is published under, never a
// version tag, its one asset reuploaded in place on every rotation
const KEY_STATE_TAG = "key-state";

// how far out the next target rotation lands, jittered so the exact
// day isn't predictable from the previous rotation's own timestamp
// see docs/Why.md#why-is-next_target_rotation_at-jittered
const ROTATION_TARGET_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const ROTATION_TARGET_JITTER_MS = 3 * 24 * 60 * 60 * 1000;

// section: key_state, the live trust state

// read the single key_state row
function getKeyState() {
  return db.prepare("SELECT * FROM key_state WHERE id = 1").get();
}

// record that a check attempt happened, success or not
function setKeyStateLastCheckedAt(lastCheckedAt) {
  db.prepare("UPDATE key_state SET last_checked_at = ? WHERE id = 1").run(lastCheckedAt);
}

// section: fetching the rotation history

// fetch a url and parse its response as json
async function fetchJson(url) {
  const res = await fetchGithub(url, USER_AGENT);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

// fetch the key-state release's own asset: every rotation record ever
// issued, oldest first, or null if none published yet
// see docs/Why.md#why-is-key_statejson-an-append-only-history-instead-of-a-single-record
async function fetchKeyStateHistory() {
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_REPO}/releases/tags/${KEY_STATE_TAG}`;
  const res = await fetchGithub(url, USER_AGENT);
  // branch: no rotation has ever been published under this tag
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const release = await res.json();
  const asset = (release.assets || []).find((a) => a.name === "key_state.json");
  // branch: the tag exists but carries no usable asset
  if (!asset) return null;
  return fetchJson(asset.browser_download_url);
}

// section: verifying a rotation record

// true only if every one of a rotation record's checks pass: the new
// key's own self-signature, the surviving slot's vouching signature,
// and a strictly-newer rotated_at than what's already trusted
function verifyKeyState(record, currentState) {
  try {
    // branch: an unrecognized slot name
    if (record.rotated_slot !== "primary" && record.rotated_slot !== "secondary") return false;
    if (!Array.isArray(record.signatures) || record.signatures.length !== 2) return false;

    const message = keyStateMessage(record);

    // the new key proving it holds the private half it claims to
    const newPublicKey = crypto.createPublicKey(record.new_public_key_pem);
    const selfSignatureOk = crypto.verify(null, message, newPublicKey, Buffer.from(record.signatures[0], "hex"));

    // the slot NOT being rotated is the one that actually authorizes this
    const survivingSlot = record.rotated_slot === "primary" ? "secondary" : "primary";
    const survivingPublicKey = crypto.createPublicKey(currentState[`${survivingSlot}_public_key_pem`]);
    const vouchSignatureOk = crypto.verify(null, message, survivingPublicKey, Buffer.from(record.signatures[1], "hex"));

    // rejects an attacker replaying an old, previously-valid record
    const currentRotatedAt = currentState[`${record.rotated_slot}_rotated_at`];
    const isNewer = new Date(record.rotated_at).getTime() > new Date(currentRotatedAt).getTime();

    return selfSignatureOk && vouchSignatureOk && isNewer;
  } catch {
    // any malformed field (bad pem, bad hex, bad date) is a rejection
    return false;
  }
}

// section: applying a verified rotation record

// rotated_at plus ~30 days, jittered a few days either way, computed
// fresh at rotation time rather than a fixed offset
function computeNextTargetRotationAt(rotatedAt) {
  const jitter = Math.floor((Math.random() * 2 - 1) * ROTATION_TARGET_JITTER_MS);
  return new Date(new Date(rotatedAt).getTime() + ROTATION_TARGET_INTERVAL_MS + jitter).toISOString();
}

// commit a verified rotation record into the trusted db row
function applyKeyStateRecord(record) {
  const nextTarget = computeNextTargetRotationAt(record.rotated_at);
  // branch: the primary slot was rotated
  if (record.rotated_slot === "primary") {
    db.prepare("UPDATE key_state SET primary_public_key_pem = ?, primary_rotated_at = ?, primary_next_target_rotation_at = ? WHERE id = 1").run(
      record.new_public_key_pem,
      record.rotated_at,
      nextTarget
    );
  } else {
    // branch: the secondary slot was rotated
    db.prepare(
      "UPDATE key_state SET secondary_public_key_pem = ?, secondary_rotated_at = ?, secondary_next_target_rotation_at = ? WHERE id = 1"
    ).run(record.new_public_key_pem, record.rotated_at, nextTarget);
  }
}

// section: the hourly poll

// fetch, verify, apply if valid, always record the attempt, never
// throws: there is no admin-facing "check now" that needs a rejection
async function checkKeyState() {
  const now = new Date().toISOString();
  try {
    const history = await fetchKeyStateHistory();
    // branch: at least one rotation has ever been published, replay
    // it in order so a record vouched by a key the same batch just
    // rotated in verifies against the now-current state, not a stale one
    if (history) {
      for (const record of history) {
        const currentState = getKeyState();
        const currentRotatedAt = currentState[`${record.rotated_slot}_rotated_at`];
        // skip: already applied or older than what's trusted, not a
        // verification failure, so it's never logged as one
        if (new Date(record.rotated_at).getTime() <= new Date(currentRotatedAt).getTime()) continue;
        if (verifyKeyState(record, currentState)) {
          applyKeyStateRecord(record);
        } else {
          console.warn(`Key-state record for slot "${record.rotated_slot}" dated ${record.rotated_at} failed verification, ignoring.`);
        }
      }
    }
    setKeyStateLastCheckedAt(now);
  } catch (err) {
    setKeyStateLastCheckedAt(now);
    console.warn(`Key-state check failed: ${err.message}`);
  }
}

// start the hourly background poll, same interval as the version
// update check
function startKeyStateCheck() {
  checkKeyState();
  const timer = setInterval(checkKeyState, CHECK_INTERVAL_MS);
  // never keeps the process alive on its own
  timer.unref();
  return timer;
}

module.exports = {
  KEY_STATE_TAG,
  getKeyState,
  fetchKeyStateHistory,
  verifyKeyState,
  applyKeyStateRecord,
  checkKeyState,
  startKeyStateCheck,
  computeNextTargetRotationAt,
};
