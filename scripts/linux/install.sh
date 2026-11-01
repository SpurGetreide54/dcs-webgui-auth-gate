#!/bin/sh
# guided installer for the auth-gate side, on the VM. Mirrors
# scripts/windows/install.ps1's role for the mission-agent side: one
# command, safe to re-run, writes .env and deploys the a/b layout.
#
# Replaces docs/A-B-Self-Update.md's "auth-gate side" prerequisites
# steps and Installation.md's manual .env setup. Run as root.
#
# Usage: sudo sh scripts/linux/install.sh [--short | --complex] [flags]
#
# Every field below has a long flag and a short flag (first letter of
# each word). A flagged field is never prompted for.
#
#   --short / -s      only ask the mandatory fields
#   --complex / -c    ask the full field set
#   (neither, and no field flags at all: asks once, interactively)
#
# Mandatory (always checked):
#   --install-dir / -id            <path>   default /var/www/dcs-webgui-auth-gate
#   --service-account / -sa        <name>   default dcs-webgui-auth-gate
#   --mission-agent-url / -mau     <url>    no default, required
#   --mission-agent-token / -mat   <token>  may be left blank
#
# Complex-only (checked under --complex, or when passed explicitly):
#   --port / -p                    <port>   default 3000
#   --brand-name / -bn             <name>   default "DCS Auth Gate"
#   --max-mission-bytes / -mmb     <bytes>  default 209715200
#   --webgui-control-port / -wcp   <port>   default 8088
#   --state-dir / -sd              <path>   default <install dir>

set -eu

# section: must run as root, no re-exec, no self-escalation
if [ "$(id -u)" -ne 0 ]; then
  echo "==> This script must run as root (sudo sh scripts/linux/install.sh ...)." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SERVICE_UNIT_NAME="dcs-webgui-auth-gate"
SERVICE_UNIT_PATH="/etc/systemd/system/$SERVICE_UNIT_NAME.service"
ROLLBACK_UNIT_PATH="/etc/systemd/system/$SERVICE_UNIT_NAME-rollback.service"

# section: hardcoded defaults, overridden below by a flag, an existing
# deployed unit (install dir, service account), or an existing .env
INSTALL_DIR_DEFAULT="/var/www/dcs-webgui-auth-gate"
SERVICE_ACCOUNT_DEFAULT="dcs-webgui-auth-gate"
PORT_DEFAULT="3000"
BRAND_NAME_DEFAULT="DCS Auth Gate"
MAX_MISSION_BYTES_DEFAULT="209715200"
WEBGUI_CONTROL_PORT_DEFAULT="8088"

# section: parse arguments
SHORT_FLAG=0
COMPLEX_FLAG=0
FLAGS_GIVEN=0
INSTALL_DIR_SET=0
SERVICE_ACCOUNT_SET=0
MISSION_AGENT_URL_SET=0
MISSION_AGENT_TOKEN_SET=0
PORT_SET=0
BRAND_NAME_SET=0
MAX_MISSION_BYTES_SET=0
WEBGUI_CONTROL_PORT_SET=0
AUTH_GATE_STATE_DIR_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --short|-s) SHORT_FLAG=1; shift ;;
    --complex|-c) COMPLEX_FLAG=1; shift ;;
    --install-dir|-id) INSTALL_DIR=$2; INSTALL_DIR_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --service-account|-sa) SERVICE_ACCOUNT=$2; SERVICE_ACCOUNT_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --mission-agent-url|-mau) MISSION_AGENT_URL=$2; MISSION_AGENT_URL_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --mission-agent-token|-mat) MISSION_AGENT_TOKEN=$2; MISSION_AGENT_TOKEN_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --port|-p) PORT=$2; PORT_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --brand-name|-bn) BRAND_NAME=$2; BRAND_NAME_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --max-mission-bytes|-mmb) MAX_MISSION_BYTES=$2; MAX_MISSION_BYTES_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --webgui-control-port|-wcp) WEBGUI_CONTROL_PORT=$2; WEBGUI_CONTROL_PORT_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    --state-dir|-sd) AUTH_GATE_STATE_DIR=$2; AUTH_GATE_STATE_DIR_SET=1; FLAGS_GIVEN=1; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ "$SHORT_FLAG" -eq 1 ] && [ "$COMPLEX_FLAG" -eq 1 ]; then
  echo "==> --short and --complex are mutually exclusive." >&2
  exit 1
fi

# section: resolve short/complex mode
# --short/--complex win outright; a bare field flag with neither
# implies --short (an automated, pre-seeded call, not a guided one);
# truly nothing at all asks once, interactively
if [ "$SHORT_FLAG" -eq 1 ]; then
  MODE="short"
elif [ "$COMPLEX_FLAG" -eq 1 ]; then
  MODE="complex"
elif [ "$FLAGS_GIVEN" -eq 1 ]; then
  MODE="short"
else
  printf 'Short setup (mandatory fields only) or complex (full field set)? [short]: '
  read -r MODE_ANSWER
  case "$MODE_ANSWER" in
    complex|Complex|c|C) MODE="complex" ;;
    *) MODE="short" ;;
  esac
fi

# section: helper functions

# prompts for a field, default shown bracketed, blank input keeps it;
# does nothing if the field was already flagged on the command line
prompt_field() {
  already_set=$1
  label=$2
  default=$3
  varname=$4
  if [ "$already_set" -eq 1 ]; then
    return
  fi
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default"
  else
    printf '%s: ' "$label"
  fi
  read -r input
  if [ -z "$input" ]; then
    input=$default
  fi
  eval "$varname=\$input"
}

# same as prompt_field, but loops until a non-blank value is given,
# for a field with no sane default on a first run
prompt_required_field() {
  already_set=$1
  label=$2
  default=$3
  varname=$4
  if [ "$already_set" -eq 1 ]; then
    return
  fi
  while :; do
    prompt_field 0 "$label" "$default" "$varname"
    eval "value=\$$varname"
    if [ -n "$value" ]; then
      return
    fi
    echo "This value is required." >&2
  done
}

# reads one key's current value out of an existing .env file, empty
# if the file or the key doesn't exist yet
read_env_value() {
  env_file=$1
  key=$2
  if [ -f "$env_file" ]; then
    awk -F= -v k="$key" '$1==k{print substr($0, length(k)+2)}' "$env_file" | tail -n1
  fi
}

# read_env_value, falling back to a given default when it's empty
env_value_or_default() {
  env_file=$1
  key=$2
  fallback=$3
  current=$(read_env_value "$env_file" "$key")
  if [ -n "$current" ]; then
    printf '%s' "$current"
  else
    printf '%s' "$fallback"
  fi
}

# replaces key's line in-place if present, appends it otherwise;
# every other line in the file is left byte-for-byte untouched
set_env_value() {
  env_file=$1
  key=$2
  value=$3
  touch "$env_file"
  # value goes through the environment, not -v, so a literal
  # backslash in it survives: awk's -v assignment runs escape
  # processing on its argument, ENVIRON does not
  SET_ENV_VALUE_K=$key SET_ENV_VALUE_V=$value awk -F= '
    BEGIN { k = ENVIRON["SET_ENV_VALUE_K"]; v = ENVIRON["SET_ENV_VALUE_V"] }
    $1==k { print k"="v; found=1; next }
    { print }
    END { if (!found) print k"="v }
  ' "$env_file" > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
}

# section: install dir and service account, remembered across a
# re-run from the already-deployed unit file, not .env
# see docs/Why.md#why-does-installsh-read-the-deployed-unit-file-for-its-rerun-defaults-not-env
INSTALL_DIR_DEFAULT_EFFECTIVE=$INSTALL_DIR_DEFAULT
SERVICE_ACCOUNT_DEFAULT_EFFECTIVE=$SERVICE_ACCOUNT_DEFAULT
if [ -f "$SERVICE_UNIT_PATH" ]; then
  existing_working_dir=$(sed -n 's/^WorkingDirectory=//p' "$SERVICE_UNIT_PATH" | tail -n1)
  existing_user=$(sed -n 's/^User=//p' "$SERVICE_UNIT_PATH" | tail -n1)
  [ -n "$existing_working_dir" ] && INSTALL_DIR_DEFAULT_EFFECTIVE=$existing_working_dir
  [ -n "$existing_user" ] && SERVICE_ACCOUNT_DEFAULT_EFFECTIVE=$existing_user
fi

prompt_field "$INSTALL_DIR_SET" "Install directory" "$INSTALL_DIR_DEFAULT_EFFECTIVE" INSTALL_DIR
prompt_field "$SERVICE_ACCOUNT_SET" "Service account name" "$SERVICE_ACCOUNT_DEFAULT_EFFECTIVE" SERVICE_ACCOUNT

ENV_PATH="$INSTALL_DIR/.env"

# section: mandatory fields, current .env value (if any) as the default
prompt_required_field "$MISSION_AGENT_URL_SET" "Mission agent URL" "$(env_value_or_default "$ENV_PATH" MISSION_AGENT_URL "")" MISSION_AGENT_URL
prompt_field "$MISSION_AGENT_TOKEN_SET" "Mission agent token (blank if not deployed yet)" "$(env_value_or_default "$ENV_PATH" MISSION_AGENT_TOKEN "")" MISSION_AGENT_TOKEN

if [ -z "$MISSION_AGENT_TOKEN" ]; then
  echo "==> No mission agent token set. The auth-gate cannot reach the mission agent yet."
  echo "==> Deploy the mission agent, then re-run this script with its generated token."
fi

# section: complex-only fields, skipped and left at their resolved
# current-or-default value under --short, unless the field's own
# flag was passed
PORT_CURRENT=$(env_value_or_default "$ENV_PATH" PORT "$PORT_DEFAULT")
BRAND_NAME_CURRENT=$(env_value_or_default "$ENV_PATH" BRAND_NAME "$BRAND_NAME_DEFAULT")
MAX_MISSION_BYTES_CURRENT=$(env_value_or_default "$ENV_PATH" MAX_MISSION_BYTES "$MAX_MISSION_BYTES_DEFAULT")
WEBGUI_CONTROL_PORT_CURRENT=$(env_value_or_default "$ENV_PATH" WEBGUI_CONTROL_PORT "$WEBGUI_CONTROL_PORT_DEFAULT")
AUTH_GATE_STATE_DIR_CURRENT=$(env_value_or_default "$ENV_PATH" AUTH_GATE_STATE_DIR "$INSTALL_DIR")

if [ "$MODE" = "complex" ]; then
  prompt_field "$PORT_SET" "Port" "$PORT_CURRENT" PORT
  prompt_field "$BRAND_NAME_SET" "Brand name" "$BRAND_NAME_CURRENT" BRAND_NAME
  prompt_field "$MAX_MISSION_BYTES_SET" "Max mission upload size, in bytes" "$MAX_MISSION_BYTES_CURRENT" MAX_MISSION_BYTES
  prompt_field "$WEBGUI_CONTROL_PORT_SET" "Webgui control port" "$WEBGUI_CONTROL_PORT_CURRENT" WEBGUI_CONTROL_PORT
  prompt_field "$AUTH_GATE_STATE_DIR_SET" "State directory (webgui-static, active-slot, logs, sqlite)" "$AUTH_GATE_STATE_DIR_CURRENT" AUTH_GATE_STATE_DIR
fi
[ "$PORT_SET" -eq 1 ] || [ "$MODE" = "complex" ] || PORT=$PORT_CURRENT
[ "$BRAND_NAME_SET" -eq 1 ] || [ "$MODE" = "complex" ] || BRAND_NAME=$BRAND_NAME_CURRENT
[ "$MAX_MISSION_BYTES_SET" -eq 1 ] || [ "$MODE" = "complex" ] || MAX_MISSION_BYTES=$MAX_MISSION_BYTES_CURRENT
[ "$WEBGUI_CONTROL_PORT_SET" -eq 1 ] || [ "$MODE" = "complex" ] || WEBGUI_CONTROL_PORT=$WEBGUI_CONTROL_PORT_CURRENT
[ "$AUTH_GATE_STATE_DIR_SET" -eq 1 ] || [ "$MODE" = "complex" ] || AUTH_GATE_STATE_DIR=$AUTH_GATE_STATE_DIR_CURRENT

# section: AUTH_GATE_STATE_DIR's five derived paths, computed once,
# used below for chown targets and the rollback unit's own hardcoded
# paths, see docs/Why.md#why-does-auth_gate_state_dir-not-replace-the-older-vars
WEBGUI_STATIC_PATH="$AUTH_GATE_STATE_DIR/webgui-static"
ACTIVE_SLOT_PATH="$AUTH_GATE_STATE_DIR/active-slot"
AUTH_GATE_LOG_PATH="$AUTH_GATE_STATE_DIR/auth-gate.log"
# the service unit's own stdout/stderr redirect, not AUTH_GATE_LOG_PATH
# see docs/Why.md#why-does-the-service-unit-redirect-stdoutstderr-to-their-own-file-not-the-app-log
NATIVE_CRASH_LOG_PATH="$AUTH_GATE_STATE_DIR/auth-gate-native-crash.log"

# section: write .env, every other existing line untouched
echo "==> Writing $ENV_PATH"
mkdir -p "$INSTALL_DIR"
set_env_value "$ENV_PATH" PORT "$PORT"
set_env_value "$ENV_PATH" MISSION_AGENT_URL "$MISSION_AGENT_URL"
set_env_value "$ENV_PATH" MISSION_AGENT_TOKEN "$MISSION_AGENT_TOKEN"
set_env_value "$ENV_PATH" MAX_MISSION_BYTES "$MAX_MISSION_BYTES"
set_env_value "$ENV_PATH" WEBGUI_CONTROL_PORT "$WEBGUI_CONTROL_PORT"
set_env_value "$ENV_PATH" BRAND_NAME "$BRAND_NAME"
set_env_value "$ENV_PATH" AUTH_GATE_STATE_DIR "$AUTH_GATE_STATE_DIR"
# always true: this script only ever targets a production VM deploy,
# the plain-http exception is for local dev only, never run through here
set_env_value "$ENV_PATH" COOKIE_SECURE "true"

# section: service account, idempotent
if ! getent group "$SERVICE_ACCOUNT" >/dev/null 2>&1; then
  echo "==> Creating group $SERVICE_ACCOUNT"
  groupadd --system "$SERVICE_ACCOUNT"
fi
if ! getent passwd "$SERVICE_ACCOUNT" >/dev/null 2>&1; then
  echo "==> Creating user $SERVICE_ACCOUNT"
  useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$SERVICE_ACCOUNT" "$SERVICE_ACCOUNT"
fi

# section: a/b layout, mirrors docs/A-B-Self-Update.md's prerequisites
# only on a true first install: once active-slot exists, the
# self-update system is the sole owner of releases/*'s contents, see
# docs/Why.md#why-does-installsh-leave-an-existing-active-slot-file-alone
if [ ! -f "$ACTIVE_SLOT_PATH" ]; then
  echo "==> Seeding releases/a from $ROOT_DIR"
  mkdir -p "$INSTALL_DIR/releases/a" "$INSTALL_DIR/releases/b"
  rsync -a --exclude releases --exclude local-only --exclude webgui-static --exclude node_modules \
    "$ROOT_DIR/" "$INSTALL_DIR/releases/a/"
  if [ ! -d "$ROOT_DIR/node_modules" ]; then
    echo "==> $ROOT_DIR/node_modules not found. A release download already includes it; a git checkout needs npm install first." >&2
    exit 1
  fi
  cp -r "$ROOT_DIR/node_modules" "$INSTALL_DIR/releases/a/node_modules"
  chown -R "$SERVICE_ACCOUNT:$SERVICE_ACCOUNT" "$INSTALL_DIR/releases"
else
  echo "==> releases/ already deployed, leaving it to the self-update system"
fi

# a custom state dir (--state-dir) may not exist yet, unlike
# $INSTALL_DIR itself, which is already created above
mkdir -p "$AUTH_GATE_STATE_DIR"

# a fresh active-slot always starts at "a", an existing one is left
# alone, see docs/Why.md#why-does-installsh-leave-an-existing-active-slot-file-alone
if [ ! -f "$ACTIVE_SLOT_PATH" ]; then
  printf '%s' a > "$ACTIVE_SLOT_PATH"
fi
chown "$SERVICE_ACCOUNT:$SERVICE_ACCOUNT" "$ACTIVE_SLOT_PATH"

echo "==> Copying launcher.js"
cp "$ROOT_DIR/launcher.js" "$INSTALL_DIR/launcher.js"

# section: systemd units, paths substituted only on their own
# anchored line, every other line copied through unchanged
echo "==> Installing systemd units"
sed \
  -e "s#^User=.*#User=$SERVICE_ACCOUNT#" \
  -e "s#^Group=.*#Group=$SERVICE_ACCOUNT#" \
  -e "s#^WorkingDirectory=.*#WorkingDirectory=$INSTALL_DIR#" \
  -e "s#^EnvironmentFile=.*#EnvironmentFile=$ENV_PATH#" \
  -e "s#^StandardOutput=append:.*#StandardOutput=append:$NATIVE_CRASH_LOG_PATH#" \
  -e "s#^StandardError=append:.*#StandardError=append:$NATIVE_CRASH_LOG_PATH#" \
  "$SCRIPT_DIR/../systemd/$SERVICE_UNIT_NAME.service" > "$SERVICE_UNIT_PATH"
sed \
  -e "s#STATE_FILE=$INSTALL_DIR_DEFAULT/active-slot#STATE_FILE=$ACTIVE_SLOT_PATH#" \
  -e "s#LOG_FILE=$INSTALL_DIR_DEFAULT/auth-gate.log#LOG_FILE=$AUTH_GATE_LOG_PATH#" \
  "$SCRIPT_DIR/../systemd/$SERVICE_UNIT_NAME-rollback.service" > "$ROLLBACK_UNIT_PATH"
systemctl daemon-reload
systemctl enable "$SERVICE_UNIT_NAME"

echo "==> Starting service"
systemctl restart "$SERVICE_UNIT_NAME"
sleep 3

if systemctl is-active --quiet "$SERVICE_UNIT_NAME"; then
  echo "==> Done. Service '$SERVICE_UNIT_NAME' is active."
else
  echo "==> Service '$SERVICE_UNIT_NAME' did not come up. Check: systemctl status $SERVICE_UNIT_NAME" >&2
  exit 1
fi
echo "    Status:  systemctl status $SERVICE_UNIT_NAME"
echo "    Log:     $AUTH_GATE_LOG_PATH"
echo "    Native crash log: $NATIVE_CRASH_LOG_PATH"
