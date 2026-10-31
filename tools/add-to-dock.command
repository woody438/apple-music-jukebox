#!/bin/bash
# Put Jukebox.app on the Dock, optionally at a chosen position.
#
#   ./tools/add-to-dock.command          -> adds it at the far right
#   ./tools/add-to-dock.command 3        -> adds it 3rd from the left
#
# Positions count the app icons only, from the left, starting at 1. Finder is
# pinned by the Dock itself and is not counted. Running it twice does not make
# two icons: an existing Jukebox entry is removed first.
#
# Dragging the icon by hand does the same job and never goes wrong. This is
# here for setting up a second machine the same way as the first.

set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$(cd "$HERE/.." && pwd)/Jukebox.app"
POS="${1:-}"

if [ ! -d "$APP" ]; then
  echo "Jukebox.app not found at $APP"
  read -r -p "Press return to close. "; exit 1
fi

# defaults export/import is the supported way in: writing the plist file
# directly fights the preferences daemon, which caches and overwrites it.
defaults export com.apple.dock - | APP="$APP" POS="$POS" python3 -c '
import os, plistlib, sys

app = os.environ["APP"]
pos = os.environ.get("POS", "").strip()

data = plistlib.loads(sys.stdin.buffer.read())   # a pipe is not seekable, so load() will not do
apps = data.get("persistent-apps", [])

def is_jukebox(entry):
    try:
        return entry["tile-data"]["file-data"]["_CFURLString"].rstrip("/").endswith("Jukebox.app")
    except Exception:
        return False

apps = [e for e in apps if not is_jukebox(e)]

entry = {
    "tile-type": "file-tile",
    "tile-data": {
        "file-label": "Jukebox",
        "file-data": {"_CFURLString": app, "_CFURLStringType": 0},
    },
}

if pos:
    try:
        index = max(0, min(len(apps), int(pos) - 1))
    except ValueError:
        index = len(apps)
else:
    index = len(apps)

apps.insert(index, entry)
data["persistent-apps"] = apps
plistlib.dump(data, sys.stdout.buffer, fmt=plistlib.FMT_XML)
' | defaults import com.apple.dock -

killall Dock
echo "Jukebox is on the Dock${POS:+ at position $POS}."
