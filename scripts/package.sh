#!/usr/bin/env bash
# Build the frontend and produce a Decky-installable zip:
#   out/moondeck-apollo.zip  ->  moondeck-apollo/{plugin.json,main.py,dist/,py_modules/,bin/,...}
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=moondeck-apollo
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    pnpm install --frozen-lockfile
    pnpm run build
fi
[[ -f dist/index.js ]] || { echo "dist/index.js missing - run pnpm build" >&2; exit 1; }

mkdir -p "$STAGE/$NAME"
cp -r plugin.json package.json main.py LICENSE README.md dist bin "$STAGE/$NAME/"
mkdir -p "$STAGE/$NAME/py_modules"
cp -r py_modules/moondeck_apollo "$STAGE/$NAME/py_modules/"
find "$STAGE" -name '__pycache__' -prune -exec rm -rf {} +
rm -f "$STAGE/$NAME/dist/"*.map
chmod 755 "$STAGE/$NAME/bin/moonlight-runner.sh"

mkdir -p out
rm -f "out/$NAME.zip"
(cd "$STAGE" && zip -qr -X "$OLDPWD/out/$NAME.zip" "$NAME")
sha256sum "out/$NAME.zip" | tee "out/$NAME.zip.sha256"
