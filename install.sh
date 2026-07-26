#!/bin/sh

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for command in uv node npm; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$command" >&2
    exit 1
  fi
done

if ! command -v opencode >/dev/null 2>&1; then
  printf '%s\n' "Warning: opencode is not on PATH. Control can be installed, but managed project servers will not start until OpenCode is installed."
fi

BUILD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/opencode-control-install.XXXXXX")
trap 'rm -rf "$BUILD_DIR"' EXIT HUP INT TERM

printf '%s\n' "Building OpenCode Control frontend..."
(cd "$ROOT/web" && npm ci && npm run build)

printf '%s\n' "Building OpenCode Control wheel..."
(cd "$ROOT" && uv build --wheel --out-dir "$BUILD_DIR")

set -- "$BUILD_DIR"/opencode_control-*.whl
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  printf '%s\n' "Expected exactly one OpenCode Control wheel" >&2
  exit 1
fi
WHEEL=$1

STATUS=$(cd "$ROOT" && uv run opencode-control status 2>/dev/null || true)
WAS_RUNNING=false
RESTART=false
case "$STATUS" in
  running*) WAS_RUNNING=true ;;
esac

if [ "$WAS_RUNNING" = true ]; then
  if [ -t 0 ]; then
    printf '%s' "OpenCode Control is running. Restart it after installation? [y/N] "
    read -r answer
    case "$answer" in
      y|Y|yes|YES) RESTART=true ;;
    esac
  fi
  if [ "$RESTART" = true ]; then
    (cd "$ROOT" && uv run opencode-control stop)
  fi
fi

printf '%s\n' "Installing OpenCode Control..."
uv tool install --force --python 3.12 "$WHEEL"

CONTROL_BIN="$(uv tool dir --bin)/opencode-control"
if [ ! -x "$CONTROL_BIN" ]; then
  printf 'Installed executable was not found: %s\n' "$CONTROL_BIN" >&2
  exit 1
fi

BIN_DIR=$(dirname -- "$CONTROL_BIN")
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *)
    UPDATE_PATH=false
    if [ -t 0 ]; then
      printf '%s' "Add the uv tool directory to your shell PATH? [Y/n] "
      read -r path_answer
      case "$path_answer" in
        n|N|no|NO) ;;
        *) UPDATE_PATH=true ;;
      esac
    fi
    if [ "$UPDATE_PATH" = true ]; then
      uv tool update-shell
      printf '%s\n' "PATH updated. Open a new terminal to use opencode-control directly."
    fi
    ;;
esac

if [ "${OPENCODE_CONTROL_INSTALL_NO_START:-0}" = "1" ]; then
  printf '%s\n' "Installed successfully. Automatic start was disabled."
elif [ "$WAS_RUNNING" = false ] || [ "$RESTART" = true ]; then
  "$CONTROL_BIN" start
else
  printf '%s\n' "Installed successfully. The existing process was left running."
  printf 'Restart when ready: %s restart\n' "$CONTROL_BIN"
fi

printf 'Installed command: %s\n' "$CONTROL_BIN"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) printf '%s\n' "If opencode-control is not on PATH in a new terminal, run: uv tool update-shell" ;;
esac
