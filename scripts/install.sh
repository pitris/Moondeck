#!/usr/bin/env bash
# Install (or update) Moondeck Apollo into Decky Loader from Desktop Mode / SSH.
#
#   bash install.sh                      # download the latest GitHub release
#   bash install.sh ./moondeck-apollo.zip
#
# The recommended route is Decky's own "Install plugin from ZIP" (see
# docs/INSTALL.md); this script is the fallback. It needs sudo because Decky's
# plugin folder is owned by root.
set -euo pipefail

NAME=moondeck-apollo
REPO=pitris/Moondeck
DECKY_HOME="${DECKY_HOME:-$HOME/homebrew}"
PLUGINS="$DECKY_HOME/plugins"

[[ -d "$PLUGINS" ]] || { echo "Decky Loader not found at $DECKY_HOME. Install Decky first: https://decky.xyz" >&2; exit 1; }

ZIP="${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [[ -z "$ZIP" ]]; then
    ZIP="$TMP/$NAME.zip"
    echo "Downloading latest release of $REPO…"
    curl -fL "https://github.com/$REPO/releases/latest/download/$NAME.zip" -o "$ZIP"
fi
# SteamOS ships bsdtar (libarchive); unzip may be missing.
if command -v bsdtar >/dev/null 2>&1; then
    list() { bsdtar -tf "$1"; }; extract() { sudo bsdtar -xf "$1" -C "$2"; }
elif command -v unzip >/dev/null 2>&1; then
    list() { unzip -Z1 "$1"; }; extract() { sudo unzip -oq "$1" -d "$2"; }
else
    list() { python3 -m zipfile -l "$1"; }; extract() { sudo python3 -m zipfile -e "$1" "$2"; }
fi
list "$ZIP" | grep -q "$NAME/plugin.json" || { echo "$ZIP is not a valid $NAME package (broken download?)" >&2; exit 1; }

# Keep a copy of settings/mappings before touching anything.
if [[ -d "$DECKY_HOME/settings/$NAME" ]]; then
    BK="$HOME/$NAME-settings-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar -czf "$BK" -C "$DECKY_HOME/settings" "$NAME"
    echo "Settings backed up to $BK"
fi

echo "Installing to $PLUGINS/$NAME (sudo)…"
sudo rm -rf "$PLUGINS/$NAME"
extract "$ZIP" "$PLUGINS"
sudo chmod 755 "$PLUGINS/$NAME/bin/moonlight-runner.sh"
sudo systemctl restart plugin_loader
echo "Done. Return to Gaming Mode; Moondeck Apollo appears in the Decky menu."
