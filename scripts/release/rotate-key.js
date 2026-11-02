#!/usr/bin/env node
// drives signing-key rotation's automatable halves: a routine
// secondary rotation, and drafting/finalizing a primary rotation
// see docs/Why.md#why-is-tooling-split-into-automatable-and-user-run-only-halves
//
// Usage:
//   node scripts/release/rotate-key.js secondary
//   node scripts/release/rotate-key.js primary-draft
//   node scripts/release/rotate-key.js primary-finalize --vouch-signature <hex>

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { keyStateMessage } = require("../../src/keyRotationConstants");

// override lets tests point this script at a throwaway temp
// directory instead of the real local-only/keys
const KEYS_DIR = process.env.ROTATE_KEY_KEYS_DIR || path.join(__dirname, "..", "..", "local-only", "keys");
// same override pattern, for the release output directory
const RELEASE_DIR = process.env.ROTATE_KEY_RELEASE_DIR || path.join(__dirname, "..", "..", "local-only", "release");
const DRAFT_PATH = path.join(RELEASE_DIR, "key_state.draft.json");
const FINAL_PATH = path.join(RELEASE_DIR, "key_state.json");

// the durable append-only log every rotation gets added to, kept
// beside the key material since release build output doesn't survive
// between releases
const HISTORY_PATH = path.join(KEYS_DIR, "key-rotation-history.json");

// the private key file for a slot, optionally a ".next" draft copy
function keyPath(slot, suffix = "") {
  return path.join(KEYS_DIR, `key-rotation-${slot}${suffix}.pem`);
}

// the public key file for a slot, optionally a ".next" draft copy
function pubKeyPath(slot, suffix = "") {
  return path.join(KEYS_DIR, `key-rotation-${slot}${suffix}.pub.pem`);
}

// every rotation record ever appended, oldest first, empty if this is
// the first rotation this machine has ever done
function loadHistory() {
  return fs.existsSync(HISTORY_PATH) ? JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")) : [];
}

// adds one record to the durable log and returns the full history,
// the array rotate-key.js then publishes in full each time
function appendToHistory(record) {
  const history = loadHistory();
  history.push(record);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  return history;
}

// moves an existing file aside with a timestamp suffix instead of
// overwriting it outright, so a rotation never destroys the previous
// key's own history
function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const backupPath = `${filePath}.${Date.now()}.bak`;
  fs.renameSync(filePath, backupPath);
  console.log(`Backed up ${filePath} -> ${backupPath}`);
}

// the shared closing instructions every rotation path ends with
function printPublishReminder() {
  console.log("");
  console.log(`Next: create or update the GitHub Release tagged "key-state" (never a version tag),`);
  console.log(`and upload ${FINAL_PATH} as its sole asset, overwriting any existing one in place --`);
  console.log(`it now holds the full rotation history, not just this one record.`);
}

// rotating secondary: primary (already on this machine) vouches,
// fully automatable end to end
function rotateSecondary() {
  const primaryPrivateKey = crypto.createPrivateKey(fs.readFileSync(keyPath("primary"), "utf8"));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const newPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const record = {
    rotated_slot: "secondary",
    new_public_key_pem: newPublicKeyPem,
    rotated_at: new Date().toISOString(),
  };
  const message = keyStateMessage(record);
  const selfSignature = crypto.sign(null, message, privateKey).toString("hex");
  const vouchSignature = crypto.sign(null, message, primaryPrivateKey).toString("hex");
  record.signatures = [selfSignature, vouchSignature];

  backupIfExists(keyPath("secondary"));
  backupIfExists(pubKeyPath("secondary"));
  fs.writeFileSync(keyPath("secondary"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(pubKeyPath("secondary"), newPublicKeyPem);

  const history = appendToHistory(record);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(FINAL_PATH, JSON.stringify(history, null, 2));
  console.log(`Wrote ${FINAL_PATH}`);
  printPublishReminder();
}

// rotating primary, automatable half: generates the new primary
// keypair into *.next.pem (untouched until primary-finalize confirms
// secondary's vouch), self-signs, and drafts the record for signing
function rotatePrimaryDraft() {
  // refuse rather than back up: a second draft makes the first
  // draft's vouch signature useless anyway, so silently backing it
  // up would hide that a first draft was already pending, not
  // preserve anything worth keeping
  const existing = [DRAFT_PATH, keyPath("primary", ".next"), pubKeyPath("primary", ".next")].filter(fs.existsSync);
  if (existing.length > 0) {
    throw new Error(`A primary draft is already pending: ${existing.join(", ")}. Finalize it with primary-finalize, or delete these files first.`);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const newPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const record = {
    rotated_slot: "primary",
    new_public_key_pem: newPublicKeyPem,
    rotated_at: new Date().toISOString(),
  };
  const message = keyStateMessage(record);
  const selfSignature = crypto.sign(null, message, privateKey).toString("hex");
  record.signatures = [selfSignature];

  // create the keys directory on first-ever rotation, same as a
  // fresh clone with no local-only/keys yet
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  fs.writeFileSync(keyPath("primary", ".next"), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.writeFileSync(pubKeyPath("primary", ".next"), newPublicKeyPem);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(DRAFT_PATH, JSON.stringify(record, null, 2));

  console.log(`Wrote ${DRAFT_PATH}`);
  console.log("");
  console.log("Next, run this yourself, in your own terminal; the secondary key must never be pasted into a script or tool:");
  console.log(`  node scripts/release/sign-key-state-with-secondary.js --draft ${DRAFT_PATH} --secondary-key <path to your secondary key>`);
  console.log("Then come back with its printed signature for:");
  console.log("  node scripts/release/rotate-key.js primary-finalize --vouch-signature <that signature>");
}

// rotating primary, finishing half: verifies the user's pasted-back
// secondary signature, then publishes history and promotes *.next.pem
function rotatePrimaryFinalize(vouchSignature) {
  if (!vouchSignature) throw new Error("--vouch-signature is required.");
  const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, "utf8"));
  if (draft.rotated_slot !== "primary" || draft.signatures.length !== 1) {
    throw new Error(`${DRAFT_PATH} is not a pending primary-rotation draft.`);
  }

  const message = keyStateMessage(draft);
  const secondaryPublicKey = crypto.createPublicKey(fs.readFileSync(pubKeyPath("secondary"), "utf8"));
  const vouchOk = crypto.verify(null, message, secondaryPublicKey, Buffer.from(vouchSignature, "hex"));
  if (!vouchOk) throw new Error("That signature does not verify against this machine's own trusted secondary public key. Nothing was published.");

  const record = { ...draft, signatures: [...draft.signatures, vouchSignature] };
  const history = appendToHistory(record);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(FINAL_PATH, JSON.stringify(history, null, 2));

  backupIfExists(keyPath("primary"));
  backupIfExists(pubKeyPath("primary"));
  fs.renameSync(keyPath("primary", ".next"), keyPath("primary"));
  fs.renameSync(pubKeyPath("primary", ".next"), pubKeyPath("primary"));

  fs.rmSync(DRAFT_PATH, { force: true });
  console.log(`Wrote ${FINAL_PATH} and promoted the new primary key into place.`);
  printPublishReminder();
}

// parses the one command-line subcommand and dispatches to it
function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    // branch: routine secondary rotation, fully automatable
    case "secondary":
      rotateSecondary();
      break;
    // branch: primary rotation's automatable first half
    case "primary-draft":
      rotatePrimaryDraft();
      break;
    // branch: primary rotation's automatable finishing half
    case "primary-finalize": {
      const flagIndex = rest.indexOf("--vouch-signature");
      const vouchSignature = flagIndex === -1 ? undefined : rest[flagIndex + 1];
      rotatePrimaryFinalize(vouchSignature);
      break;
    }
    // branch: anything else is a usage error
    default:
      throw new Error(`Unknown command: ${command}. Expected secondary, primary-draft, or primary-finalize.`);
  }
}

main();
