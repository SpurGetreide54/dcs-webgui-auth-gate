#!/bin/sh
# Builds src/agent.js into a standalone Windows agent.exe. The DCS host
# then needs no Node.js install. Uses Node's own Single Executable
# Application (SEA) support: bundle -> SEA blob -> inject into a copy of
# the real Windows node.exe. Safe to run from any OS. Injection is just PE
# resource editing, not something that needs to run on Windows itself.
#
# Usage: sh scripts/build-agent-exe.sh
# Output: local-only/release/agent/agent-<version>.exe

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_DIR="$ROOT_DIR/local-only/build"
RELEASE_DIR="$ROOT_DIR/local-only/release/agent"

NODE_VERSION="v24.19.0"
NODE_ZIP="node-$NODE_VERSION-win-x64.zip"
NODE_ZIP_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP"
# Pinned against nodejs.org's own SHASUMS256.txt for this release. Checked
# in here, not trusted fresh from a re-downloaded checksums file each
# build, so a compromised/altered download also has to fake a value that
# lives in this repo's own git history, not just whatever nodejs.org serves
# today.
NODE_ZIP_SHA256="57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73"

VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")

mkdir -p "$BUILD_DIR" "$RELEASE_DIR"
cd "$BUILD_DIR"

echo "==> Bundling src/agent.js"
npx esbuild "$ROOT_DIR/src/agent.js" --bundle --platform=node --target=node24 --outfile=agent-bundle.js

echo "==> Generating SEA blob"
cat > sea-config.json <<'EOF'
{
  "main": "agent-bundle.js",
  "output": "agent.blob",
  "disableExperimentalSEAWarning": true
}
EOF
node --experimental-sea-config sea-config.json

echo "==> Fetching Windows node.exe ($NODE_VERSION), verifying checksum"
if [ ! -f "$NODE_ZIP" ] || ! echo "$NODE_ZIP_SHA256  $NODE_ZIP" | sha256sum -c - >/dev/null 2>&1; then
  curl -sL -o "$NODE_ZIP" "$NODE_ZIP_URL"
fi
echo "$NODE_ZIP_SHA256  $NODE_ZIP" | sha256sum -c -

unzip -o -j "$NODE_ZIP" "node-$NODE_VERSION-win-x64/node.exe" -d .

OUT_EXE="$RELEASE_DIR/agent-$VERSION.exe"
cp node.exe "$OUT_EXE"

echo "==> Injecting SEA blob"
npx postject "$OUT_EXE" NODE_SEA_BLOB agent.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --overwrite

echo "==> Built $OUT_EXE"
echo "    Note: injecting into node.exe invalidates its original Microsoft"
echo "    Authenticode signature (postject warns about this) — Windows"
echo "    SmartScreen/Defender may flag the result as unsigned. Expected;"
echo "    not a build failure. Sign it yourself or allowlist it locally."
