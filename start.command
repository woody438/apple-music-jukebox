#!/bin/bash
# Double-click this to run the party jukebox.
set -u
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8484}"
BOLD=$'\033[1m'; DIM=$'\033[2m'; OFF=$'\033[0m'

printf '\n%s  PARTY JUKEBOX%s\n\n' "$BOLD" "$OFF"

# ---- Node ------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not installed.\n\n'
  printf '  Install it with Homebrew, then run this again:\n'
  printf '      brew install node\n\n'
  printf '  (No Homebrew? Get it from https://brew.sh first.)\n\n'
  read -r -p "  Press return to close. "
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  printf '  Node %s is too old -- the jukebox needs 18 or newer.\n' "$(node -v)"
  printf '      brew upgrade node\n\n'
  read -r -p "  Press return to close. "
  exit 1
fi
printf '  Node %s\n' "$(node -v)"

# ---- Music -----------------------------------------------------------------
if pgrep -xq Music; then
  printf '  Music is running\n'
else
  printf '  Opening Music...\n'
  open -a Music
  sleep 4
fi

# ---- server ----------------------------------------------------------------
printf '  Starting the jukebox on port %s...\n\n' "$PORT"
PORT="$PORT" node server.js &
SERVER_PID=$!

# No sleep, no display sleep, for exactly as long as the server lives.
caffeinate -dimsu -w "$SERVER_PID" &
CAFFEINATE_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  kill "$CAFFEINATE_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

# ---- open the browser once it is actually listening ------------------------
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/config" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    printf '\n  The server stopped while starting up. Scroll up for the reason.\n\n'
    read -r -p "  Press return to close. "
    exit 1
  fi
  sleep 1
done

open "http://localhost:${PORT}/"

printf '\n%s  Jukebox is up.%s\n' "$BOLD" "$OFF"
printf '    Full screen in the browser: %scontrol-command-F%s\n' "$BOLD" "$OFF"
printf '    Host panel:                 %scontrol-option-H%s\n' "$BOLD" "$OFF"
printf '    Stop the jukebox:           %scontrol-C%s in this window\n\n' "$BOLD" "$OFF"
printf '%s    The Mac will not sleep while this window is open.%s\n\n' "$DIM" "$OFF"

wait "$SERVER_PID"
