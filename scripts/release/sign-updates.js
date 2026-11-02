#!/usr/bin/env node
// builds and signs signed_updates.json, the manifest updateCheck.js
// verifies before trusting a release, run by hand after both
// artifacts already exist
//
// Usage:
//   node scripts/release/sign-updates.js \
//     --version 1.4.3-alpha \
//     --changelog-url https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases/tag/1.4.3-alpha \
//     --auth-gate local-only/release/auth-gate/auth-gate-1.4.3-alpha.tar.gz \
//     --agent local-only/release/agent/agent-1.4.3-alpha.exe \
//     --key local-only/keys/key-rotation-primary.pem \
//     [--needs-service-update] \
//     [--tag 1.4.3-alpha] \
//     [--allow-legacy-key]
//
// the private key never leaves this machine, local-only/ is gitignored
// only its public half ships with the app, read from keyRotationConstants.js
// and the live key_state row at runtime, see docs/Why.md#why-does-verifymanifest-read-key_state-instead-of-a-hardcoded-constant

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { GITHUB_REPO } = require("../../src/updateConstants");
const { PRIMARY_PUBLIC_KEY_PEM } = require("../../src/keyRotationConstants");

// the durable append-only rotation log rotate-key.js writes to,
// same path it uses
const KEY_ROTATION_HISTORY_PATH = path.join(__dirname, "..", "..", "local-only", "keys", "key-rotation-history.json");

// the public key this release's signature must match: the newest
// primary rotation ever recorded, or the original hardcoded key if
// primary has never been rotated
function resolveTrustRootPem() {
  if (fs.existsSync(KEY_ROTATION_HISTORY_PATH)) {
    const history = JSON.parse(fs.readFileSync(KEY_ROTATION_HISTORY_PATH, "utf8"));
    const newestPrimaryRotation = history.filter((record) => record.rotated_slot === "primary").at(-1);
    if (newestPrimaryRotation) return newestPrimaryRotation.new_public_key_pem;
  }
  return PRIMARY_PUBLIC_KEY_PEM;
}

// turn the cli's --flags into a plain args object, with required-field checks
function parseArgs(argv) {
  const args = { needsServiceUpdate: false, allowLegacyKey: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--version":
        args.version = argv[++i];
        break;
      case "--changelog-url":
        args.changelogUrl = argv[++i];
        break;
      case "--auth-gate":
        args.authGatePath = argv[++i];
        break;
      case "--agent":
        args.agentPath = argv[++i];
        break;
      case "--needs-service-update":
        args.needsServiceUpdate = true;
        break;
      case "--tag":
        args.tag = argv[++i];
        break;
      case "--key":
        args.keyPath = argv[++i];
        break;
      case "--allow-legacy-key":
        args.allowLegacyKey = true;
        break;
      case "--out":
        args.outPath = argv[++i];
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (!args.version) throw new Error("--version is required.");
  if (!args.changelogUrl) throw new Error("--changelog-url is required.");
  if (!args.authGatePath) throw new Error("--auth-gate is required.");
  if (!args.agentPath) throw new Error("--agent is required.");
  if (!args.keyPath) throw new Error("--key is required.");
  args.tag = args.tag || args.version;
  return args;
}

// hash one file's contents for the manifest's own sha256 field
function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// build this artifact's github releases download url
function downloadUrl(tag, filename) {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${filename}`;
}

// parse args, build and sign the manifest, then write it out
function main() {
  const args = parseArgs(process.argv.slice(2));

  const privateKey = crypto.createPrivateKey(fs.readFileSync(args.keyPath, "utf8"));

  // refuse a stale or wrong key by default, failing loudly instead of
  // signing with a key no install trusts; --allow-legacy-key exists
  // only for the one release that must still carry the retired key
  if (!args.allowLegacyKey) {
    const keyPublicPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    const trustRootPem = resolveTrustRootPem();
    if (keyPublicPem !== trustRootPem) {
      throw new Error(`${args.keyPath}'s public half does not match the current trust root. Pass --allow-legacy-key only for the one release that must still be signed with a retired key.`);
    }
  }

  // fixed key order matters here, see
  // docs/Why.md#why-does-sign-updatesjs-care-about-key-order
  const signed = {
    version: args.version,
    changelog_url: args.changelogUrl,
    needs_service_update: args.needsServiceUpdate,
    downloads: [
      { artifact: "auth-gate", url: downloadUrl(args.tag, path.basename(args.authGatePath)), sha256: sha256File(args.authGatePath) },
      { artifact: "agent", url: downloadUrl(args.tag, path.basename(args.agentPath)), sha256: sha256File(args.agentPath) },
    ],
  };

  const signature = crypto.sign(null, Buffer.from(JSON.stringify(signed)), privateKey).toString("hex");
  const manifest = { ...signed, signature };

  const outPath = args.outPath || path.join(__dirname, "..", "..", "local-only", "release", "signed_updates.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));

  console.log(`Wrote ${outPath}`);
  console.log(`Upload it alongside ${path.basename(args.authGatePath)} and ${path.basename(args.agentPath)} to the GitHub Release tagged "${args.tag}".`);
}

main();
