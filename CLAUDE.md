# CLAUDE.md — Party Jukebox

Guidance for working in this repo. Read this before changing the engine.

## What it is

A web jukebox that drives the macOS **Music** app through AppleScript and JXA.
The laptop shows the cabinet full-screen; guests pick from their phones on the
same Wi-Fi. Picks play first come, first served. When picks run out, Music's
own Autoplay keeps the room going.

**Zero npm runtime dependencies. No build step. Nothing fetched at run time.**
Fonts are base64 in `public/fonts.css`; the QR library is vendored. If you are
tempted to add a dependency, don't — the party Wi-Fi gets no say in whether
the jukebox boots.

## Hard constraints — settled, do not relitigate

- **No MusicKit, no Apple Music API.** There is no Apple Developer account.
  AppleScript/JXA can only see **library** tracks, and that is the whole scope.
- **The Playing Next queue is not scriptable.** This is why the server owns the
  queue and the playlist is only a mirror. Do not try to drive Playing Next.
- **Autoplay (∞) is not scriptable.** It is toggled by hand in Music before the
  party. The engine works with it, not against it.
- **Unchecked tracks are skipped by Music inside playlists**, so they are
  excluded from the index. A guest picking one would get silence.
- **Cloud statuses `ineligible`, `removed`, `error`, `no longer available`,
  `prerelease` are excluded.** JXA spells enums inconsistently across versions
  (`noLongerAvailable` vs `no longer available`), so every enum is normalised
  in `lib/util.js`, never compared raw.
- **Shuffle off, repeat off** at startup and before every play.

## Architecture

```
server.js            HTTP, SSE, routes, CONFIG block at the top
lib/engine.js        the queue engine (see below) -- the part that matters
lib/music.js         osascript bridge, write mutex, reserved-name guard
lib/mock-music.js    simulated Music, same API, for tests and demos
lib/library.js       raw columns -> index (filters, sort, codes, genres)
lib/util.js          enum normalising, accent folding, sort keys
lib/state.js         data/state.json, atomic write-then-rename
scripts/*.js         JXA READS, returning JSON
scripts/*.applescript  AppleScript WRITES
public/              the UI: index.html, style.css, app.js, fonts.css
preflight.js         checks against the REAL Music app, PASS/FAIL per step
test/mock-suite.js   engine tests, no Mac needed
test/ui-suite.js     browser tests, optional, needs Playwright
test/party-rehearsal.js  end-to-end against a RUNNING server (mock or real)
tools/build-fonts.js regenerates public/fonts.css from assets/fonts
tools/check-timing.js  read-only: state-read latency, and duration vs finish
Jukebox.app/         Dock launcher: double-click toggles the server on/off
Update.command       manual update: refuses while running, pulls, runs tests
test/genre-panel.js  browser tests for the genre settings panel
demo/                self-contained UI demo: build.js welds the real markup,
                     stylesheet and fonts to an in-page simulator (demo-app.js)
                     plus a 338-track demo library. Proves nothing about Music.
```

### What a real Music app actually does

Measured during preflight on a 13,375-track library, worth knowing before
changing anything:

- **`play` does not make the playlist the playback context.** Playing a track
  inside the "Jukebox Preflight" playlist left `current playlist` reporting
  **"Music"**, not the playlist. So Music will not reliably walk the playlist
  on its own after a pick ends. The forced handoff is not belt-and-braces, it
  is the mechanism. Nothing in `lib/engine.js` branches on `currentPlaylist`
  for exactly this reason — every decision is made on the track's persistent
  ID. Keep it that way.
- Indexing 13,375 tracks takes about **1 second**.
- **A state read costs about 316ms** (measured, `tools/check-timing.js`), and
  the position it reports is stale by that whole round trip. Tracks are NOT
  trimmed: 0 of 13,375 had a finish point before their duration, so early
  endings are not the explanation for anything.
- **This is why the handoff is booked, not watched for.** 200ms timer plus a
  316ms read is a ~516ms effective poll period, against a 600ms window —
  84ms of slack. Any jitter steps straight over the window: 1.1s left, then
  already ended. A real rehearsal did exactly that and fell back on the
  recovery path. So `_armHandoff` sets a timer for the moment the handoff is
  due and plays the pick WITHOUT another read; the poll check and the
  recovery rule remain underneath it as fallbacks.
  Two traps, both of which this has already fallen into:
  the timer must NOT be cancelled at the top of each tick (that leaves the
  engine blind for the whole read, and the handoff lands in the hole), and a
  test for this must be run with the fix removed to prove it fails — at 300ms
  latency it passes either way and proves nothing. Test 15 uses 700ms because
  that is where the difference decides the outcome.
- Artist names really do start with `&` and `'` (`&ME, Black Coffee,
  Keinemusik`; `'Little' Louie Vega & Mark Anthony`). They bucket under `#`
  on the A-Z rail, which is correct. Nothing is ever addressed by name — only
  by persistent ID — so punctuation in titles and artists cannot break a
  script argument.

**Reads are JXA, writes are AppleScript.** JXA can return JSON in one round
trip; AppleScript has the saner syntax for mutation. The library index is a
**bulk property fetch** — `tracks.name()`, `tracks.artist()` and so on, one
Apple Event per column. Fetching per track would take minutes on a large
library.

**The mock samples the player BEFORE its simulated latency, never after.** A
real osascript reads the player near the start of its run and hands that
reading back ~300ms later, so what arrives describes the past -- including
which track was playing. Sleeping and then sampling is easier and is a lie:
it hid a real bug (a read in flight across a handoff wiping the pick's name,
so the song played out labelled AUTOPLAY) until a party rehearsal found it.
`PICK_SETTLE_MS` and the `readStartedAtMs` check in `_tickOnce` are what
make the engine ignore a reading older than the action it is judging.

A regression test for that race needs the poll loop to have settled into its
rhythm first: firing the handoff immediately after a pick lands on the wrong
side of the cycle and the race never happens. Test 17 sleeps 250ms first,
and fails 3 times out of 3 with the fix removed.

Enum values come back from JXA **raw** and are normalised in Node. That is
deliberate: it keeps every exclusion rule unit-testable without a Mac.

### Deviation from the original brief

The brief put the queue engine inside `server.js`. It lives in `lib/engine.js`
instead, so the mock suite can drive it directly without an HTTP server. The
config block stayed at the top of `server.js` as asked.

## The queue engine

The server owns the queue in memory and persists it to `data/state.json`. The
Music playlist is a **mirror** of `[current pick, ...queued picks]`, never the
source of truth.

- **Pick** → validate → append to the end of the Jukebox playlist.
- **Polling** is adaptive: ~800 ms, dropping to ~200 ms when under 4 s remain.
  Poll ticks are skipped entirely while a Music write is in flight.
- **Handoff:** when picks are waiting and the current track has **≤0.6 s** left
  — any track, pick or Autoplay — force the next pick by persistent ID inside
  the playlist. This deliberately clips under a second of tail. That is
  inaudible against a room, and it is the only way to guarantee Autoplay never
  gets a gap to slot a song into, whether or not Music notices tracks appended
  to a playlist it is already playing.
- **Duplicate persistent IDs:** always play the **last** match in the playlist.
  The earlier entry is one already played.
- **Promotion:** if Music starts the queue head by itself, adopt it rather than
  restarting it.
- **Stopped** → start the next pick at once.
- **Hold:** paused counts as hold once Music has been seen playing. Picks queue
  but nothing starts until playback resumes. Paused *at startup* — which nobody
  did on purpose — leaves hold clear, so the first pick starts playback.
- **Missing from the playlist at handoff** → rebuild the playlist from the
  queue, then play.
- **Housekeeping:** queue empty and nothing of ours playing → clear the
  playlist, at most every 15 s.

### The one subtle rule

Two requirements look contradictory:

> a pick made during Autoplay waits for the Autoplay song to end
> a track changing to anything else while picks wait starts the next pick now

They are distinguished by **when the pick was added relative to when the
current song started**, not by whether a track change was seen between two
polls. An 800 ms poll lands on either side of a pick at random, so the
change-detection version cut off Autoplay songs roughly half the time.

```js
const trackStartedAtMs = nowMs() - pos * 1000;   // from the player position
const missedHandoff = this.queue[0].addedAt < trackStartedAtMs - 250;
```

- pick added **after** this song started → somebody chose during Autoplay.
  Ride it out, hand off at the end.
- pick added **before** this song started → this song began while a pick was
  waiting, so the handoff was missed. Take the room back now.

If you change this, run test 3 and test 10 in `test/mock-suite.js`. They fail
in opposite directions and pin the behaviour between them.

## Browsing a large library

The library is far too big to page through end to end, so there are three
routes in, and they interact by design:

- **Genre** (`genre` in `public/app.js`, `ALL` / a genre name / `OTHER`).
  `lib/library.js` groups genres case-insensitively, settles on the commonest
  spelling, writes that back onto every row, and ships `genres: [{name,
  count}]` sorted by count. The client gives the top `MAX_GENRE_BUTTONS` (18)
  their own button and rolls the tail into `OTHER`, which matches rows whose
  genre is not in the top set.
- **A-Z rail**, computed from the CURRENT view (`viewLetterStart`), not the
  whole library — otherwise a genre with no Q artists offers a Q that jumps
  nowhere.
- **Search**, in a drawer behind the SEARCH button.

**Genre and search are mutually exclusive, deliberately.** Searching sets
`genre = ALL`; selecting a genre clears `query` and closes the drawer. The
alternative — searching within the selected genre — silently hides matches
from a guest who cannot see why, and at a party nobody debugs that, they just
conclude the jukebox is broken.

Selection codes stay **global**: a code is computed over the whole library in
`lib/library.js`, so within a genre they look non-contiguous (B-26, B-35,
B-84). That is correct — the code identifies a song, not a position in the
current filter.

### Attract mode

Idle laptop → `kickAttract()` → after `ATTRACT_IDLE_MS` the cabinet flips a
page every `ATTRACT_STEP_MS`, advancing to the next genre at the end of one.
Guards: laptop only (never phones — battery), never over an open confirm card
or search drawer, never while a search is active, and any input kills it.
Separate from the 90s `IDLE_RESET_MS`, which resets genre and search.

## Safety rules around the library

These are not negotiable. It is somebody's real music library.

- **Never run `delete` against a library playlist.** Only ever against the
  Jukebox user playlist, where delete removes a playlist entry and leaves the
  library track alone.
- Every mutating AppleScript refuses a **smart** playlist.
- `lib/music.js` refuses a set of **reserved names** (`Library`, `Music`,
  `Podcasts`, …) before any script runs.
- `preflight.js` works only in its own **"Jukebox Preflight"** playlist and
  asserts the library track count is unchanged at the end.
- **All Music writes go through one mutex.** Two osascript processes talking to
  Music at once is how Apple Events wedge and the room goes silent.

## Known risks

| Risk | Where it bites | Mitigation |
|---|---|---|
| ~~The AppleScript/JXA layer was never executed~~ **CLEARED** | — | Preflight passed 17/17 against real Music on macOS 25.6 (darwin), Node 26.8, over a 13,375-track library. Every script in `scripts/` works. Re-run `node preflight.js` after any change to them. |
| Bulk index on a very large library | Slow, or one bad track fails a whole column | Measured: **13,375 tracks indexed in 1.0s**, so this is not the problem it looked like. Each column is still fetched independently; a failure is recorded in `partial` rather than aborting. Only `pid` is mandatory. |
| Crossfade left on | Two songs overlap at handoff | README checklist item 1 |
| Rectangle/Magnet own ⌃⌥←/→ | Skip hotkey does nothing | `preflight.js` checks; change `MODIFIER` in `public/app.js` |
| Guest Wi-Fi client isolation | Phones load nothing | README checklist item 4 |
| Index payload on a huge library | Slow first load on a phone | Rows are arrays not objects, gzipped once and served with an ETag, so each phone pays it once. Measured on a real library: **12,751 tracks = 1.32 MB raw, 0.49 MB gzipped.** Mock tracks have short synthetic names, so mock figures understate this by roughly 3x — do not size from them. |
| `position` jitter from Music | Handoff fires slightly early or late | 250 ms margin in the missed-handoff test; handoff clips <1 s by design |

## How to run things

```bash
node test/mock-suite.js                 # engine tests, no Mac, ~15s
VERBOSE=1 node test/mock-suite.js       # with engine logging

MOCK=1 node server.js                   # simulator on :8484
MOCK=1 PUBLIC_URL="http://192.168.1.42:8484/" node server.js   # with a QR
node test/ui-suite.js /tmp/shots        # browser tests (needs Playwright)
node test/party-rehearsal.js           # end-to-end against a running server
node test/party-rehearsal.js --fast    # same, skipping through the queued picks

node demo/build.js                      # rebuild demo/jukebox-demo.html after a UI change
node preflight.js                       # against REAL Music, on the Mac
./start.command                         # the party
```

Useful mock switches: `MOCK_LIBRARY` (track count), `MOCK_TRACK_SECONDS`,
`MOCK_AUTOPLAY=0`, `MOCK_APPEND_PICKED_UP=1` (simulate Music noticing tracks
appended to a playing playlist).

## House style

- Plain CommonJS, no transpiling, no framework. `var` in `public/app.js` on
  purpose — it runs on whatever phone turns up.
- Keep changes surgical. This runs at a party tomorrow, not in a sprint.
- Comment the *why*, especially anything that looks like it could be
  simplified. Most of the odd-looking code here is load-bearing.
