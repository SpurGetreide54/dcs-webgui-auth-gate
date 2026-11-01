#!/usr/bin/env node
// drives the fully-automatable halves of signing-key rotation: a
// routine secondary rotation (primary vouches, no user step needed),
// and the drafting/finalizing halves of a primary rotation (secondary
// must vouch, via the separate user-run-only
// sign-key-state-with-secondary.js), see
// docs/Why.md#why-is-tooling-split-into-automatable-and-user-run-only-halves
//
// Usage:
//   node scripts/release/rotate-key.js secondary
//   node scripts/release/rotate-key.js primary-draft
//   node scripts/release/rotate-key.js primary-finalize --vouch-signature <hex>

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const KEYS_DIR = path.join(__dirname, "..", "..", "local-only", "keys");
const RELEASE_DIR = path.join(__dirname, "..", "..", "local-only", "release");
const DRAFT_PATH = path.join(RELEASE_DIR, "key_state.draft.json");
const FINAL_PATH = path.join(RELEASE_DIR, "key_state.json");

// the durable append-only log every rotation gets added to, kept next
// to the key material itself since local-only/release/ gets swept
// into local-only/release-archive/ before every routine version
// release, see docs/Why.md#why-is-key_statejson-an-append-only-history-instead-of-a-single-record
const HISTORY_PATH = path.join(KEYS_DIR, "key-rotation-history.json");

// the private key file for a slot, optionally a ".next" draft copy
function keyPath(slot, suffix = "") {
  return path.join(KEYS_DIR, `key-rotation-${slot}${suffix}.pem`);
}

// the public key file for a slot, optionally a ".next" draft copy
function pubKeyPath(slot, suffix = "") {
  return path.join(KEYS_DIR, `key-rotation-${slot}${suffix}.pub.pem`);
}

// fixed key order matters here, same message shape src/keyRotation.js verifies
function keyStateMessage({ rotated_slot, new_public_key_pem, rotated_at }) {
  return Buffer.from(JSON.stringify({ rotated_slot, new_public_key_pem, rotated_at }));
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
  fs.writeFileSync(keyPath("secondary"), privateKey.export({ type: "pkcs8", format: "pem" }));
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

  fs.writeFileSync(keyPath("primary", ".next"), privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(pubKeyPath("primary", ".next"), newPublicKeyPem);
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.writeFileSync(DRAFT_PATH, JSON.stringify(record, null, 2));

  console.log(`Wrote ${DRAFT_PATH}`);
  console.log("");
  console.log("Next, run this yourself, in your own terminal -- the secondary key never belongs in an AI session:");
  console.log(`  node scripts/release/sign-key-state-with-secondary.js --draft ${DRAFT_PATH} --secondary-key <path to your secondary key>`);
  console.log("Then come back with its printed signature for:");
  console.log("  node scripts/release/rotate-key.js primary-finalize --vouch-signature <that signature>");
}

// rotating primary, finishing half: takes the signature the user
// signed with secondary and pasted back, verifies it against the
// secondary public key this machine already trusts, and only then
// publishes the updated history and promotes *.next.pem into place
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
