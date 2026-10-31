#!/bin/bash
# Double-click to update the jukebox. Never runs on its own.
#
# There is deliberately no automatic updater. An updater's whole job is to
# change the code, and the one night this matters that is downside with no
# upside. This one refuses to run while the jukebox is up, pulls, and then
# proves the engine still works before you trust it.

set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8484}"
B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; O=$'\033[0m'

printf '\n%s  UPDATE PARTY JUKEBOX%s\n\n' "$B" "$O"

finish() { printf '\n'; read -r -p "  Press return to close. "; exit "${1:-0}"; }

# --- never mid-party -------------------------------------------------------
if /usr/sbin/lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '%s  The jukebox is RUNNING.%s\n\n' "$R" "$O"
  printf '  Stop it first (double-click Jukebox.app), then run this again.\n'
  printf '  Updating underneath a running party is how a good night ends early.\n'
  finish 1
fi

# --- node ------------------------------------------------------------------
NODE=""
for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  [ -x "$c" ] && NODE="$c" && break
done
[ -z "$NODE" ] && NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ]; then
  printf '%s  Node.js not found.%s  Install it with:  brew install node\n' "$R" "$O"
  finish 1
fi

# --- local edits? ----------------------------------------------------------
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  printf '%s  You have local changes to these files:%s\n\n' "$Y" "$O"
  git status --short | sed 's/^/    /'
  printf '\n  Pulling could conflict with them, so nothing was changed.\n'
  printf '  Keep them:     git stash\n'
  printf '  Throw away:    git checkout -- .\n'
  printf '  ...then run this again.\n'
  finish 1
fi

# --- pull ------------------------------------------------------------------
BEFORE="$(git rev-parse --short HEAD)"
printf '  Checking for updates...\n\n'
if ! git pull --ff-only 2>&1 | sed 's/^/    /'; then
  printf '\n%s  Could not pull.%s  Check your internet, then try again.\n' "$R" "$O"
  finish 1
fi
AFTER="$(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  printf '\n%s  Already up to date%s (%s).\n' "$G" "$O" "$AFTER"
  finish 0
fi

printf '\n  Updated %s -> %s\n' "$BEFORE" "$AFTER"
printf '\n  What changed:\n'
git log --oneline "$BEFORE..$AFTER" | sed 's/^/    /'

# --- prove it still works --------------------------------------------------
printf '\n  Checking the engine still works...\n\n'
if "$NODE" test/mock-suite.js 2>&1 | tail -3 | sed 's/^/    /'; then
  :
fi

if "$NODE" test/mock-suite.js >/dev/null 2>&1; then
  printf '\n%s  All good.%s Start it from the Dock when you are ready.\n' "$G" "$O"
  finish 0
else
  printf '\n%s  The tests FAILED on this update.%s\n\n' "$R" "$O"
  printf '  Go back to the version you had:\n'
  printf '      git checkout %s\n\n' "$BEFORE"
  printf '  ...and tell Claude the output above.\n'
  finish 1
fi
