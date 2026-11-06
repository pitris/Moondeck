#!/usr/bin/env bash
# Moondeck Apollo runner.
#
# Steam launches this script through a hidden non-Steam shortcut, so Moonlight
# runs as a Steam "game": gamescope focuses its window, Steam Input applies the
# shortcut's controller layout, and when Moonlight exits Steam returns to
# Gaming Mode.
#
# The plugin backend writes a one-shot request file next to this script just
# before asking Steam to launch it. Without a fresh request (e.g. the hidden
# shortcut was started by hand) we simply open the Moonlight UI.

set -u

DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REQ="$DIR/launch-request.sh"
RESULT="$DIR/last-session.env"
LOG="$DIR/moonlight-last.log"
MAX_AGE=120

# Steam's runtime library path can break host binaries such as flatpak.
unset LD_LIBRARY_PATH

ML_ARGV=()
ML_CREATED=0
if [[ -f "$REQ" ]]; then
    # shellcheck disable=SC1090
    source "$REQ"
    rm -f "$REQ"
fi

now="$(date +%s)"
if (( ${#ML_ARGV[@]} == 0 || now - ML_CREATED > MAX_AGE )); then
    echo "[runner] no fresh launch request; opening Moonlight UI" >"$LOG"
    if command -v flatpak >/dev/null 2>&1; then
        exec flatpak run com.moonlight_stream.Moonlight
    fi
    exit 1
fi

{
    echo "[runner] $(date -Is) starting: ${ML_ARGV[*]}"
} >"$LOG"

started="$(date +%s)"
"${ML_ARGV[@]}" >>"$LOG" 2>&1 &
child=$!

# Forward Steam's "Exit game" (SIGTERM) to Moonlight so the session closes
# cleanly instead of leaving an orphaned stream.
trap 'kill -TERM "$child" 2>/dev/null' TERM INT HUP
wait "$child"
code=$?
# wait returns early (>128) when a trapped signal arrives; wait again for the child.
if kill -0 "$child" 2>/dev/null; then
    wait "$child"
    code=$?
fi
ended="$(date +%s)"

{
    echo "EXIT_CODE=$code"
    echo "STARTED_AT=$started"
    echo "ENDED_AT=$ended"
    echo "APP_NAME=${ML_META_APP_NAME:-}"
    echo "STEAM_APPID=${ML_META_STEAM_APPID:-}"
} >"$RESULT.tmp" && mv -f "$RESULT.tmp" "$RESULT"

exit "$code"
