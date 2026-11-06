#!/usr/bin/env bash
# Remove Moondeck Apollo.
#
# Best done in two steps:
#   1. Gaming Mode: Decky → Moondeck Apollo → Settings → Backup & uninstall →
#      "Remove Steam shortcut and runtime files" (this removes the hidden
#      "Moonlight (Apollo)" shortcut through Steam's own API).
#   2. Uninstall the plugin in Decky's settings, or run this script.
#
#   bash uninstall.sh          # remove plugin + runtime files, keep settings
#   bash uninstall.sh --purge  # also delete settings (a tar.gz backup is made first)
set -euo pipefail

NAME=moondeck-apollo
DECKY_HOME="${DECKY_HOME:-$HOME/homebrew}"
PURGE=0
[[ "${1:-}" == "--purge" ]] && PURGE=1

if [[ -d "$DECKY_HOME/settings/$NAME" ]]; then
    BK="$HOME/$NAME-settings-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$BK" -C "$DECKY_HOME/settings" "$NAME"
    echo "Settings backed up to $BK"
fi

if [[ -d "$DECKY_HOME/plugins/$NAME" ]]; then
    sudo rm -rf "$DECKY_HOME/plugins/$NAME"
    echo "Removed plugin."
fi
rm -rf "$DECKY_HOME/data/$NAME" "$HOME/.local/share/$NAME" 2>/dev/null || sudo rm -rf "$DECKY_HOME/data/$NAME"
rm -rf "$DECKY_HOME/logs/$NAME" 2>/dev/null || true
if (( PURGE )); then
    rm -rf "$DECKY_HOME/settings/$NAME" 2>/dev/null || sudo rm -rf "$DECKY_HOME/settings/$NAME"
    echo "Removed settings."
fi
if systemctl list-unit-files plugin_loader.service >/dev/null 2>&1; then
    sudo systemctl restart plugin_loader || true
fi

cat <<MSG
Moondeck Apollo removed.
If you skipped step 1, delete the hidden shortcut yourself in Gaming Mode:
  Library → Hidden → "Moonlight (Apollo)" (or "<Game> (Moonlight)") → ⚙ → Manage → Remove non-Steam game.
Nothing else was changed: Moonlight, Apollo and Steam's own files are untouched.
MSG
