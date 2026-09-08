#!/bin/bash
# Loads this working copy into IINA as a development package.
#
#   ./scripts/dev.sh           link the working copy
#   ./scripts/dev.sh --unlink  remove the link
#
# IINA reads the source through a symlink, so reloading the plugin picks up edits
# with no rebuild or reinstall. IINA names the link after this directory, not the
# plugin identifier, so a clone under another name links under that name.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IINA_PLUGIN="${IINA_PLUGIN:-/Applications/IINA.app/Contents/MacOS/iina-plugin}"

[ -x "$IINA_PLUGIN" ] || { echo "error: iina-plugin not found at $IINA_PLUGIN" >&2; exit 1; }

if [ "${1:-}" = "--unlink" ]; then
  "$IINA_PLUGIN" unlink "$ROOT"
  exit 0
fi

node --check "$ROOT/main.js"
for f in "$ROOT"/ui/*.js; do node --check "$f"; done

"$IINA_PLUGIN" link "$ROOT"
echo "IINA now loads from $ROOT"
