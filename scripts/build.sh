#!/bin/bash
# Packages the plugin into dist/ as an .iinaplgz for "Install Plugin…".
#
#   ./scripts/build.sh
#
# Plain zip rather than `iina-plugin pack`, so the release workflow can run this
# same script on Linux. The two produce identical archives.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1],encoding="utf-8"))["version"])' "$ROOT/Info.json")"
OUT="$ROOT/dist/SubtitleNavigator-$VERSION.iinaplgz"
STAGE="$ROOT/dist/.stage"

# Staged so the archive holds only what the plugin ships, not docs/ or scripts/.
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$ROOT/Info.json" "$ROOT/main.js" "$STAGE/"
cp -R "$ROOT/ui" "$STAGE/"

node --check "$STAGE/main.js"
for f in "$STAGE"/ui/*.js; do node --check "$f"; done

# zip merges into an existing archive, so a stale build would survive a rename.
rm -f "$OUT"
( cd "$STAGE" && zip -qr "$OUT" Info.json main.js ui )
rm -rf "$STAGE"

echo "built: ${OUT#$ROOT/}"
