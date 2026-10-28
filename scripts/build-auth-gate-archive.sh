#!/bin/sh
# builds auth-gate-<version>.tar.gz and .zip, same contents in both,
# what updateCheck.js extracts into a fresh a/b slot and what a manual
# install unpacks by hand, node_modules is rebuilt fresh, never copied
# see docs/Why.md#why-is-node-modules-rebuilt-fresh-instead-of-copied
#
# Usage: sh scripts/build-auth-gate-archive.sh [--audit-level <level>]
#   --audit-level: npm audit severity that fails the build. Default
#     "low" (fail on anything reported at all). Only raise this (e.g. to
#     "moderate") after diagnosing every flagged advisory by hand and
#     confirming with a human that it's safe to ship anyway. Never as
#     a default, never just to get a build unstuck.

set -eu

AUDIT_LEVEL="low"
while [ $# -gt 0 ]; do
  case "$1" in
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

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_DIR="$ROOT_DIR/local-only/build/auth-gate-archive"
RELEASE_DIR="$ROOT_DIR/local-only/release/auth-gate"

VERSION=$(node -e "console.log(require('$ROOT_DIR/package.json').version)")
VERSION_FILE=$(cat "$ROOT_DIR/VERSION")
if [ "$VERSION" != "$VERSION_FILE" ]; then
  echo "==> package.json version ($VERSION) and VERSION file ($VERSION_FILE) disagree. Bump both." >&2
  exit 1
fi

# the archive's contents, named explicitly, an include list not a
# glob with excludes, anything not named here never ships
INCLUDE_LIST="src public launcher.js package.json package-lock.json LICENSE DISCLAIMER README.md .env.example docs"

echo "==> Building auth-gate archive for $VERSION"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$RELEASE_DIR"

for entry in $INCLUDE_LIST; do
  cp -R "$ROOT_DIR/$entry" "$BUILD_DIR/$entry"
done

echo "==> npm ci --omit=dev (production node_modules/)"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$BUILD_DIR/"
( cd "$BUILD_DIR" && npm ci --omit=dev )

echo "==> npm audit --omit=dev --audit-level=$AUDIT_LEVEL"
( cd "$BUILD_DIR" && npm audit --omit=dev --audit-level="$AUDIT_LEVEL" )

TAR_PATH="$RELEASE_DIR/auth-gate-$VERSION.tar.gz"
ZIP_PATH="$RELEASE_DIR/auth-gate-$VERSION.zip"

echo "==> Writing $TAR_PATH"
tar -czf "$TAR_PATH" -C "$BUILD_DIR" .

echo "==> Writing $ZIP_PATH"
rm -f "$ZIP_PATH"
( cd "$BUILD_DIR" && zip -rq "$ZIP_PATH" . )

echo "==> Built $TAR_PATH"
echo "==> Built $ZIP_PATH"
