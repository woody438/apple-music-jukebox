#!/usr/bin/env bash
# Puts the jukebox into a freshly built Party Jukebox.app: the pinned Node
# beside the app's own executable, and the jukebox code -- the same files the
# git install runs -- in Contents/Resources/jukebox. Sign after this, never
# before: anything added to a signed bundle breaks its seal.
#
#   tools/app/assemble-app.sh "Party Jukebox.app" path/to/node
set -euo pipefail
APP="$1"
NODE="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CODE="$APP/Contents/Resources/jukebox"

cp "$NODE" "$APP/Contents/MacOS/node"
chmod 755 "$APP/Contents/MacOS/node"
[ -f "$(dirname "$NODE")/node-LICENSE" ] && cp "$(dirname "$NODE")/node-LICENSE" "$APP/Contents/Resources/node-LICENSE"

rm -rf "$CODE"
mkdir -p "$CODE"
# Only what the server needs at run time. Not tests, demo, tools, data, or
# the git install's launchers.
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"     # absolute: we cd next
CODE="$APP/Contents/Resources/jukebox"
cd "$ROOT"                    # globs relative to the repo, so a path with spaces is safe
for f in server.js package.json jukebox.conf.example lib public scripts assets/fonts/LICENSE-*; do
  [ -e "$f" ] || continue
  mkdir -p "$CODE/$(dirname "$f")"
  cp -R "$f" "$CODE/$f"
done
rm -rf "$CODE/public/artwork-cache"           # written at run time, elsewhere (JUKEBOX_ARTWORK_DIR)
find "$CODE" -name .DS_Store -delete

test -f "$CODE/server.js" && test -d "$CODE/public" && test -d "$CODE/scripts"
echo "assembled: $(du -sh "$APP" | cut -f1)  ($(ls "$CODE" | tr '\n' ' '))"
