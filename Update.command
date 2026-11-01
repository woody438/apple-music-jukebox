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

# The menu bar icon is a long-running process, so it is still running the
# code from before the pull. Restart it -- through Jukebox.app, which is what
# normally starts it -- so the menu matches what is now on disk. Only if it
# was running: someone who quit it does not want it back.
# The pattern matches the icon's whole launch line, so nothing else that
# merely mentions the file (an editor, say) is killed. Same as Jukebox.app's.
MENU_PATTERN='osascript -l JavaScript .*menubar/menubar[.]js'
restart_menu_bar() {
  /usr/bin/pgrep -f "$MENU_PATTERN" >/dev/null 2>&1 || return 0
  /usr/bin/pkill -f "$MENU_PATTERN" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/pgrep -f "$MENU_PATTERN" >/dev/null 2>&1 || break
    sleep 0.2
  done
  open -g -n "$(pwd)/Jukebox.app" --args menu && printf '  Restarted the menu bar icon on the new version.\n'
}

# --- never mid-party -------------------------------------------------------
if /usr/sbin/lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '%s  The jukebox is RUNNING.%s\n\n' "$R" "$O"
  printf '  Stop it first (Stop Jukebox in the menu bar, or double-click\n'
  printf '  Jukebox.app), then run this again.\n'
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
  printf '\n%s  All good.%s Start it from the menu bar or the Dock when you are ready.\n' "$G" "$O"
  restart_menu_bar
  finish 0
else
  printf '\n%s  The tests FAILED on this update.%s\n\n' "$R" "$O"
  printf '  Go back to the version you had:\n'
  printf '      git checkout %s\n\n' "$BEFORE"
  printf '  ...and tell Claude the output above.\n'
  finish 1
fi
