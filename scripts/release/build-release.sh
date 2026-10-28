#!/bin/sh
# cuts a full release: archives the old one, builds and signs both
# artifacts, builds the manual-deployment assets, prints what's still
# left to do by hand, creating the GitHub Release, no gh cli here
#
# Usage:
#   sh scripts/release/build-release.sh \
#     --version 1.5.1-alpha \
#     --changelog-url https://github.com/SpurGetreide54/dcs-webgui-auth-gate/releases/tag/1.5.1-alpha \
#     [--needs-service-update] \
#     [--tag 1.5.1-alpha] \
#     [--audit-level <level>]
#
# Bump package.json's and VERSION's version by hand first, see
# local-only/versioning.md. This script only reads them, never writes
# them.

set -eu

NEEDS_SERVICE_UPDATE=""
TAG=""
AUDIT_LEVEL=""
VERSION_FLAG=""
CHANGELOG_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      VERSION_FLAG="$2"
      shift 2
      ;;
    --changelog-url)
      CHANGELOG_URL="$2"
      shift 2
      ;;
    --needs-service-update)
      NEEDS_SERVICE_UPDATE="--needs-service-update"
      shift
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    --audit-level)
      AUDIT_LEVEL="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ -z "$VERSION_FLAG" ] || [ -z "$CHANGELOG_URL" ]; then
  echo "Usage: sh scripts/release/build-release.sh --version <v> --changelog-url <url> [--needs-service-update] [--tag <tag>] [--audit-level <level>]" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

PKG_VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")
if [ "$VERSION_FLAG" != "$PKG_VERSION" ]; then
  echo "==> --version ($VERSION_FLAG) doesn't match package.json ($PKG_VERSION). Bump package.json/VERSION first, or fix the flag." >&2
  exit 1
fi

echo "###### Step 1/5: archive the previous release ######"
sh "$ROOT_DIR/scripts/release/archive-old-release.sh"

echo "###### Step 2/5: build the auth-gate archive ######"
if [ -n "$AUDIT_LEVEL" ]; then
  sh "$ROOT_DIR/scripts/build-auth-gate-archive.sh" --audit-level "$AUDIT_LEVEL"
else
  sh "$ROOT_DIR/scripts/build-auth-gate-archive.sh"
fi

echo "###### Step 3/5: build the agent.exe ######"
sh "$ROOT_DIR/scripts/build-agent-exe.sh"

echo "###### Step 4/5: build the agent manual-deployment zip ######"
sh "$ROOT_DIR/scripts/build-agent-manual-zip.sh"

echo "###### Step 5/5: sign the update manifest ######"
AUTH_GATE_TARBALL="$ROOT_DIR/local-only/release/auth-gate/auth-gate-$PKG_VERSION.tar.gz"
AGENT_EXE="$ROOT_DIR/local-only/release/agent/agent-$PKG_VERSION.exe"
SIGN_ARGS="--version $PKG_VERSION --changelog-url $CHANGELOG_URL --auth-gate $AUTH_GATE_TARBALL --agent $AGENT_EXE"
if [ -n "$TAG" ]; then
  SIGN_ARGS="$SIGN_ARGS --tag $TAG"
fi
# shellcheck disable=SC2086
node "$ROOT_DIR/scripts/release/sign-updates.js" $SIGN_ARGS $NEEDS_SERVICE_UPDATE

RELEASE_TAG="${TAG:-$PKG_VERSION}"
cat <<EOF

###### Still manual: create the GitHub Release ######
1. Tag: $RELEASE_TAG
2. Upload these assets from local-only/release/:
   - auth-gate/auth-gate-$PKG_VERSION.tar.gz
   - auth-gate/auth-gate-$PKG_VERSION.zip
   - agent/agent-$PKG_VERSION.exe
   - agent/agent-$PKG_VERSION.zip
   - agent/install-$PKG_VERSION.ps1
   - signed_updates.json
EOF
