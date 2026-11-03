#!/bin/sh
# runs once, as root, whenever the real unit's OnFailure= fires
# flips active-slot and restarts into the slot that was working before
# see docs/Why.md#why-is-the-rollback-a-separate-systemd-unit

set -eu

# log_file/state_file are hardcoded, not read from .env
# see docs/Why.md#why-does-the-rollback-unit-hardcode-its-own-paths
STATE_FILE=/var/www/dcs-webgui-auth-gate/active-slot
STATE_FILE="${ROLLBACK_STATE_FILE_OVERRIDE:-$STATE_FILE}"
LOG_FILE=/var/www/dcs-webgui-auth-gate/auth-gate.log
LOG_FILE="${ROLLBACK_LOG_FILE_OVERRIDE:-$LOG_FILE}"

# the service account owns this file; tolerate garbage the same way
# readActiveSlot does, so an injected value never reaches NEW or the log line
# see docs/Why.md#why-does-the-rollback-script-validate-active-slot-and-refuse-a-symlinked-log
CURRENT=$(cat "$STATE_FILE" 2>/dev/null || echo a)
case "$CURRENT" in
  a|b) ;;
  *) CURRENT=a ;;
esac
if [ "$CURRENT" = "a" ]; then NEW=b; else NEW=a; fi

# tmp-file-plus-rename: rename(2) replaces a symlink's own directory
# entry rather than following it, unlike the `>` this used to use
TMP_STATE_FILE="$STATE_FILE.$$.tmp"
printf %s "$NEW" > "$TMP_STATE_FILE"
mv "$TMP_STATE_FILE" "$STATE_FILE"
echo "Rolled back: active-slot $CURRENT -> $NEW"

# `>>` would follow a symlink and write through it as root; refusing
# narrows that window but can't close it outright, see docs/Why.md above
if [ -L "$LOG_FILE" ]; then
  echo "Refusing to append to $LOG_FILE: it is a symlink" >&2
else
  printf '{"t":"%s","level":"warn","msg":"Rolled back: active-slot %s -> %s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$CURRENT" "$NEW" >> "$LOG_FILE"
fi

# only the real unit asks for a restart; a test invoking this script
# directly sets this to exercise the state/log writes above in isolation
if [ -z "${ROLLBACK_SKIP_RESTART:-}" ]; then
  # reset-failed clears the start-limit hit that triggered this rollback,
  # or the start below is refused too
  # see docs/Why.md#why-does-the-rollback-unit-call-reset-failed-before-start
  systemctl reset-failed dcs-webgui-auth-gate
  systemctl start dcs-webgui-auth-gate
fi
