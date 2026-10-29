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
//     [--needs-service-update] \
//     [--tag 1.4.3-alpha] \
//     [--key local-only/keys/update-signing-key.pem]
//
// the private key never leaves this machine, local-only/ is gitignored
// only its public half (hardcoded in src/updateCheck.js) ships with the app

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { GITHUB_REPO } = require("../../src/updateConstants");

function parseArgs(argv) {
  const args = { needsServiceUpdate: false };
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
  args.tag = args.tag || args.version;
  args.keyPath = args.keyPath || path.join(__dirname, "..", "..", "local-only", "keys", "update-signing-key.pem");
  return args;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function downloadUrl(tag, filename) {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${filename}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const privateKey = crypto.createPrivateKey(fs.readFileSync(args.keyPath, "utf8"));

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
