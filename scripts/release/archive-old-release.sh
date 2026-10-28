#!/bin/sh
# moves local-only/release/ into local-only/release-archive/<version>/
# run before building a new release so it doesn't overwrite the old
# one's files, a no-op if local-only/release/ holds nothing yet
#
# Usage: sh scripts/release/archive-old-release.sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
RELEASE_DIR="$ROOT_DIR/local-only/release"
ARCHIVE_DIR="$ROOT_DIR/local-only/release-archive"
MANIFEST="$RELEASE_DIR/signed_updates.json"

if [ ! -f "$MANIFEST" ]; then
  echo "==> No $MANIFEST, nothing to archive."
  exit 0
fi

OLD_VERSION=$(node -e "console.log(require('$MANIFEST').version)")
DEST="$ARCHIVE_DIR/$OLD_VERSION"

if [ -e "$DEST" ]; then
  echo "==> $DEST already exists, refusing to overwrite. Resolve by hand." >&2
  exit 1
fi

echo "==> Archiving local-only/release/ (version $OLD_VERSION) to $DEST"
mkdir -p "$DEST"
for entry in "$RELEASE_DIR"/*; do
  [ -e "$entry" ] || continue
  mv "$entry" "$DEST/"
done

mkdir -p "$RELEASE_DIR/auth-gate" "$RELEASE_DIR/agent"
echo "==> Done. local-only/release/ is ready for the next build."
