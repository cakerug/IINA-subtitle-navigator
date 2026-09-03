#!/bin/bash
# Packages the plugin into dist/ as an .iinaplgz for "Install Plugin…".
#
#   ./scripts/build-plugin.sh          release build, real identifier
#   ./scripts/build-plugin.sh --dev    dev build that installs alongside the release
#
# The dev build gets its own identifier, name and menu shortcut, so IINA treats it
# as a separate plugin and both can be enabled at once for side-by-side comparison.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IINA_PLUGIN="${IINA_PLUGIN:-/Applications/IINA.app/Contents/MacOS/iina-plugin}"
DEV=0
[ "${1:-}" = "--dev" ] && DEV=1

[ -x "$IINA_PLUGIN" ] || { echo "error: iina-plugin not found at $IINA_PLUGIN" >&2; exit 1; }

# Fails the build rather than shipping a silently unpatched file.
patch() {
  local file="$1" from="$2" to="$3"
  grep -qF -- "$from" "$file" || { echo "error: pattern not found in $(basename "$file"): $from" >&2; exit 1; }
  python3 - "$file" "$from" "$to" <<'PY'
import io, sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(path, encoding="utf-8").read()
io.open(path, "w", encoding="utf-8").write(s.replace(old, new))
PY
}

NAME="SubtitleNavigator"
[ "$DEV" = 1 ] && NAME="SubtitleNavigatorDev"

STAGE="$ROOT/dist/.stage"
rm -rf "$STAGE"
mkdir -p "$STAGE/$NAME"

# Only what the plugin actually needs — not demo.mp4, docs/ or .git.
cp "$ROOT/Info.json" "$ROOT/main.js" "$STAGE/$NAME/"
cp -R "$ROOT/ui" "$STAGE/$NAME/"

if [ "$DEV" = 1 ]; then
  patch "$STAGE/$NAME/Info.json" \
    '"identifier": "info.junjie-chen.subtitle-navigator"' \
    '"identifier": "info.junjie-chen.subtitle-navigator.dev"'
  patch "$STAGE/$NAME/Info.json" \
    '"name": "Subtitle Navigator"' \
    '"name": "Subtitle Navigator (Dev)"'
  patch "$STAGE/$NAME/main.js" \
    'const PLUGIN_LABEL = "Subtitle Navigator";' \
    'const PLUGIN_LABEL = "Subtitle Navigator (Dev)";'
  # Both plugins register a menu item; identical shortcuts would collide.
  patch "$STAGE/$NAME/main.js" \
    'const MENU_SHORTCUT = "cmd+shift+s";' \
    'const MENU_SHORTCUT = "cmd+shift+d";'
fi

node --check "$STAGE/$NAME/main.js"
node --check "$STAGE/$NAME/ui/window.js"

( cd "$STAGE" && "$IINA_PLUGIN" pack "$NAME" >/dev/null )
mv "$STAGE"/*.iinaplgz "$ROOT/dist/"
rm -rf "$STAGE"

OUT="$(ls -t "$ROOT/dist"/*.iinaplgz | head -1)"
echo "built: ${OUT#$ROOT/}"
[ "$DEV" = 1 ] && echo "       dev build — installs alongside the release, opens with cmd+shift+d"
exit 0
