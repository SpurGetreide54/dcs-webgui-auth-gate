#!/bin/sh
# builds the agent's manual-deployment agent-<version>.zip and the
# standalone install-<version>.ps1, for a human installing by hand on
# a dcs host with no git clone, neither is touched by self-update
#
# Requires scripts/build-agent-exe.sh to have already built
# agent-<version>.exe this release.
#
# Usage: sh scripts/build-agent-manual-zip.sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RELEASE_DIR="$ROOT_DIR/local-only/release/agent"
BUILD_DIR="$ROOT_DIR/local-only/build/agent-manual-zip"

VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")
AGENT_EXE="$RELEASE_DIR/agent-$VERSION.exe"

if [ ! -f "$AGENT_EXE" ]; then
  echo "==> $AGENT_EXE not found. Run scripts/build-agent-exe.sh first." >&2
  exit 1
fi

# include list, what a from-scratch install needs, nothing else
echo "==> Assembling agent manual-deployment files for $VERSION"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cp "$AGENT_EXE" "$BUILD_DIR/agent.exe"
cp "$ROOT_DIR/scripts/windows/install.ps1" "$BUILD_DIR/"
cp "$ROOT_DIR/scripts/windows/uninstall.ps1" "$BUILD_DIR/"
cp "$ROOT_DIR/scripts/windows/nssm.exe" "$BUILD_DIR/"
cp "$ROOT_DIR/VERSION" "$BUILD_DIR/"
cp "$ROOT_DIR/DISCLAIMER" "$BUILD_DIR/"
cp "$ROOT_DIR/LICENSE" "$BUILD_DIR/"

ZIP_PATH="$RELEASE_DIR/agent-$VERSION.zip"
echo "==> Writing $ZIP_PATH"
rm -f "$ZIP_PATH"
( cd "$BUILD_DIR" && zip -rq "$ZIP_PATH" . )

INSTALL_PS1_PATH="$RELEASE_DIR/install-$VERSION.ps1"
echo "==> Writing $INSTALL_PS1_PATH"
cp "$ROOT_DIR/scripts/windows/install.ps1" "$INSTALL_PS1_PATH"

echo "==> Built $ZIP_PATH"
echo "==> Built $INSTALL_PS1_PATH"
