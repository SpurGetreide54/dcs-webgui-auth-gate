#!/bin/sh
# one-time migration sorting every pre-archive release's flat files
# into local-only/release-archive/<version>/, see
# local-only/release-process.md's "One-time backfill" section for why
#
# Usage: sh scripts/release/backfill-release-archive.sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
RELEASE_DIR="$ROOT_DIR/local-only/release"
ARCHIVE_DIR="$ROOT_DIR/local-only/release-archive"
GITHUB_REPO="SpurGetreide54/dcs-webgui-auth-gate"

CURRENT_VERSION=""
if [ -f "$RELEASE_DIR/signed_updates.json" ]; then
  CURRENT_VERSION=$(node -e "console.log(require('$RELEASE_DIR/signed_updates.json').version)")
  echo "==> Current live version (left alone): $CURRENT_VERSION"
fi

# move one flat release file into its version's archive folder
sort_file() {
  file="$1"
  kind="$2"
  base=$(basename "$file")
  name="$base"
  case "$name" in
    *.tar.gz) name=${name%.tar.gz} ;;
    *.zip) name=${name%.zip} ;;
    *.exe) name=${name%.exe} ;;
    *.ps1) name=${name%.ps1} ;;
    *.md) name=${name%.md} ;;
    *) echo "==> Skipping $base: unrecognized suffix." >&2; return ;;
  esac
  case "$name" in
    auth-gate-*) version=${name#auth-gate-} ;;
    agent-*) version=${name#agent-} ;;
    install-*) version=${name#install-} ;;
    release-notes-*) version=${name#release-notes-} ;;
    *) echo "==> Skipping $base: unrecognized prefix." >&2; return ;;
  esac
  if [ "$version" = "$CURRENT_VERSION" ]; then
    return
  fi
  dest_dir="$ARCHIVE_DIR/$version/$kind"
  mkdir -p "$dest_dir"
  mv "$file" "$dest_dir/"
  echo "==> Archived $base -> local-only/release-archive/$version/$kind/"
}

if [ -d "$RELEASE_DIR/auth-gate" ]; then
  for f in "$RELEASE_DIR/auth-gate"/*; do
    [ -f "$f" ] || continue
    sort_file "$f" "auth-gate"
  done
fi

if [ -d "$RELEASE_DIR/agent" ]; then
  for f in "$RELEASE_DIR/agent"/*; do
    [ -f "$f" ] || continue
    sort_file "$f" "agent"
  done
fi

echo "==> Backfilling signed_updates.json for each archived version"
if [ -d "$ARCHIVE_DIR" ]; then
  for d in "$ARCHIVE_DIR"/*/; do
    [ -d "$d" ] || continue
    version=$(basename "$d")
    manifest="$d/signed_updates.json"
    if [ -f "$manifest" ]; then
      continue
    fi
    url="https://github.com/$GITHUB_REPO/releases/download/$version/signed_updates.json"
    if curl -fsSL -o "$manifest" "$url"; then
      echo "==> Fetched signed_updates.json for $version"
    else
      rm -f "$manifest"
      echo "==> No signed_updates.json found on the GitHub release for $version (tag mismatch, or pre-dates signing). Skipping." >&2
    fi
  done
fi

echo "==> Done."
