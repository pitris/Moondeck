#!/usr/bin/env bash
# Restore a settings tarball made by install.sh / uninstall.sh.
#   bash restore-settings.sh ~/moondeck-apollo-settings-YYYYmmdd-HHMMSS.tar.gz
set -euo pipefail
NAME=moondeck-apollo
DECKY_HOME="${DECKY_HOME:-$HOME/homebrew}"
[[ -f "${1:-}" ]] || { echo "usage: $0 <backup.tar.gz>" >&2; exit 1; }
tar -tzf "$1" | grep -q "^$NAME/settings.json$" || { echo "not a $NAME settings backup" >&2; exit 1; }
mkdir -p "$DECKY_HOME/settings"
if [[ -d "$DECKY_HOME/settings/$NAME" ]]; then
    mv "$DECKY_HOME/settings/$NAME" "$DECKY_HOME/settings/$NAME.before-restore-$(date +%s)"
fi
tar -xzf "$1" -C "$DECKY_HOME/settings"
echo "Restored. Restarting Decky…"
sudo systemctl restart plugin_loader || true
