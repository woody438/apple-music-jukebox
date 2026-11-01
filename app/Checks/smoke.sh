#!/usr/bin/env bash
# Launches the built app on the CI Mac the way a person would get it -- the
# signed bundle, its own Node, its own copy of the jukebox -- and checks it
# does the job end to end, against the simulated Music (--mock):
#   - the app starts the server, which answers as the host on localhost
#   - the page, the library index and a pick all work
#   - the guest network route answers
#   - SIGTERM quits the app cleanly AND takes the server with it: no orphan
#     node left holding the port, which is the failure that would matter
#
#   app/Checks/smoke.sh "Party Jukebox.app"
set -euo pipefail
APP="$1"
PORT=8599
BIN="$APP/Contents/MacOS/Party Jukebox"
SUPPORT="$HOME/Library/Application Support/Party Jukebox"
APPLOG="${RUNNER_TEMP:-/tmp}/party-jukebox-app.log"
fail() {
  echo "SMOKE FAIL: $*" >&2
  echo "--- the app's own log:" >&2; [ -f "$APPLOG" ] && tail -40 "$APPLOG" >&2
  echo "--- the server's log:" >&2; [ -f "$SUPPORT/data/jukebox.log" ] && tail -20 "$SUPPORT/data/jukebox.log" >&2
  exit 1
}
# Gone, or a zombie nobody has collected yet: either way it has exited.
alive() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null | tr -d ' '); [ -n "$st" ] && [ "${st#Z}" = "$st" ]; }
pass() { echo "PASS  $*"; }

lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "port $PORT busy before the test"

"$BIN" --mock --port "$PORT" --no-updates >"$APPLOG" 2>&1 &
APP_PID=$!
trap 'kill -9 $APP_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1 && break
  alive "$APP_PID" || fail "the app exited before the server came up"
  sleep 0.5
done
CFG=$(curl -fsS "http://127.0.0.1:$PORT/api/config") || fail "the server never answered"
echo "$CFG" | grep -q '"isHost":true' || fail "localhost is not the host: $CFG"
echo "$CFG" | grep -q '"mock":true' || fail "not the simulated Music: $CFG"
pass "the app started the server, and localhost is the host"

NODE_PID=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN | head -1)
ps -o command= -p "$NODE_PID" | grep -q "Party Jukebox.app/Contents/MacOS/node server.js" \
  || fail "the listener is not the bundled node: $(ps -o command= -p "$NODE_PID")"
[ "$(ps -o ppid= -p "$NODE_PID" | tr -d ' ')" = "$APP_PID" ] || fail "the server is not the app's own child"
file "$APP/Contents/MacOS/node" | grep -q arm64 || fail "bundled node is not arm64"
pass "the server is the bundled node, a child of the app"

curl -fsS "http://127.0.0.1:$PORT/" | grep -qi "<html" || fail "no page"
PID_TRACK=$(curl -fsS "http://127.0.0.1:$PORT/api/index" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["rows"][0][0])') \
  || fail "no library index"
PICK=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d "{\"pid\":\"$PID_TRACK\",\"deviceId\":\"smoke\"}" "http://127.0.0.1:$PORT/api/pick")
echo "$PICK" | grep -q '"ok":true' || fail "a pick was refused: $PICK"
pass "page, index and a pick"

curl -fsS "http://127.0.0.1:$PORT/api/host/network" | grep -q '"ok":true' || fail "no guest network route"
pass "guest network route"

test -f "$SUPPORT/data/state.json" || fail "the queue was not written to Application Support"
test ! -e "$APP/Contents/Resources/jukebox/public/artwork-cache" || fail "something wrote inside the app bundle"
codesign --verify --strict "$APP" || fail "the bundle's signature broke while it ran"
pass "data in Application Support; the bundle untouched and still validly signed"

# The Settings window's helper, run as the app runs it: the bundled node and
# the bundled conf.js, against a scratch file -- a save, then a read-back.
SCRATCH="${RUNNER_TEMP:-/tmp}/smoke-jukebox.conf"
rm -f "$SCRATCH"
echo '{"JUKEBOX_TITLE":"Smoke","JUKEBOX_WIFI_NAME":"Test Net","JUKEBOX_WIFI_PASSWORD":"it'"'"'s $5 ok"}' \
  | "$APP/Contents/MacOS/node" "$APP/Contents/Resources/jukebox/lib/conf.js" write "$SCRATCH" \
      "$APP/Contents/Resources/jukebox/jukebox.conf.example" | grep -q '"ok":true' || fail "the settings helper could not save"
"$APP/Contents/MacOS/node" "$APP/Contents/Resources/jukebox/lib/conf.js" read "$SCRATCH" \
  | grep -q "\"JUKEBOX_WIFI_PASSWORD\":\"it's \$5 ok\"" || fail "the settings helper did not read the password back exactly"
pass "the Settings window's helper saves and reads back, on the bundled node"

kill -TERM "$APP_PID"
for _ in $(seq 1 40); do
  alive "$APP_PID" || break
  sleep 0.25
done
alive "$APP_PID" && fail "the app did not quit within 10 s of SIGTERM"
wait "$APP_PID" 2>/dev/null || true
sleep 0.5
alive "$NODE_PID" && fail "the server was left running after the app quit"
lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 && fail "something still holds port $PORT"
trap - EXIT
pass "SIGTERM quits the app and the server goes with it"
echo "smoke test passed"
