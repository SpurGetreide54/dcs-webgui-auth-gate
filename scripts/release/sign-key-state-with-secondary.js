#!/usr/bin/env node
// user-run-only: the secondary private key never leaving this
// script is the whole point of it
// see docs/Why.md#why-is-tooling-split-into-automatable-and-user-run-only-halves
//
// reads a pending primary-rotation draft, signs it with the secondary
// key, and prints only the resulting signature, never the key or draft
// itself; paste it into:
//
//   node scripts/release/rotate-key.js primary-finalize --vouch-signature <signature>
//
// Usage:
//   node scripts/release/sign-key-state-with-secondary.js \
//     --draft local-only/release/key_state.draft.json \
//     --secondary-key local-only/keys/key-rotation-secondary.pem

const crypto = require("node:crypto");
const fs = require("node:fs");
const { keyStateMessage } = require("../../src/keyRotationConstants");

// reads --draft and --secondary-key off the command line
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--draft":
        args.draftPath = argv[++i];
        break;
      case "--secondary-key":
        args.secondaryKeyPath = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.draftPath) throw new Error("--draft is required.");
  if (!args.secondaryKeyPath) throw new Error("--secondary-key is required.");
  return args;
}

// reads the draft and the secondary key, prints only the signature
function main() {
  const args = parseArgs(process.argv.slice(2));
  const draft = JSON.parse(fs.readFileSync(args.draftPath, "utf8"));
  if (draft.rotated_slot !== "primary") throw new Error('This draft does not have rotated_slot "primary".');

  const secondaryPrivateKey = crypto.createPrivateKey(fs.readFileSync(args.secondaryKeyPath, "utf8"));
  const signature = crypto.sign(null, keyStateMessage(draft), secondaryPrivateKey).toString("hex");

  console.log(signature);
}

main();
