#!/bin/bash
# Packages the plugin into dist/ as an .iinaplgz for "Install Plugin…".
#
#   ./scripts/build-plugin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IINA_PLUGIN="${IINA_PLUGIN:-/Applications/IINA.app/Contents/MacOS/iina-plugin}"

[ -x "$IINA_PLUGIN" ] || { echo "error: iina-plugin not found at $IINA_PLUGIN" >&2; exit 1; }

NAME="SubtitleNavigator"

STAGE="$ROOT/dist/.stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/$NAME"

# Only what the plugin actually needs — not demo.mp4, docs/ or .git.
cp "$ROOT/Info.json" "$ROOT/main.js" "$STAGE/$NAME/"
cp -R "$ROOT/ui" "$STAGE/$NAME/"

node --check "$STAGE/$NAME/main.js"
node --check "$STAGE/$NAME/ui/window.js"

( cd "$STAGE" && "$IINA_PLUGIN" pack "$NAME" >/dev/null )
mv "$STAGE"/*.iinaplgz "$ROOT/dist/"
rm -rf "$STAGE"

OUT="$(ls -t "$ROOT/dist"/*.iinaplgz | head -1)"
echo "built: ${OUT#$ROOT/}"
