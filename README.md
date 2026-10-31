# Party Jukebox

A jukebox web UI that drives the **Music app** on a Mac. The laptop shows a
1950s cabinet full-screen; guests pick songs from their phones over the same
Wi-Fi by scanning a QR code. Picks play in order, first come first served.
When the picks run out, Music's own Autoplay keeps the room going.

Your library only. No Apple Developer account, no MusicKit, no Apple Music API.
Zero npm dependencies, no build step, nothing fetched from the internet at
run time — the fonts and the QR library are in the repo.

---

## GET IT ONTO THE PARTY LAPTOP

**Clone it. Don't download the ZIP.** Two things break in a ZIP: it loses the
executable bit on `start.command`, and macOS quarantines anything downloaded
through a browser, so double-clicking gets you "cannot be opened because it is
from an unidentified developer". Cloning avoids both.

First check Node is there:

```bash
node -v
```

If that errors, or prints anything below v18:

```bash
brew install node
```

(No Homebrew? Get it from https://brew.sh first.) Then:

```bash
git clone https://github.com/woody438/apple-music-jukebox.git ~/Developer/apple-music-jukebox
```

```bash
cd ~/Developer/apple-music-jukebox && node preflight.js
```

**Do preflight before anything else.** It is the only thing that has ever
exercised the AppleScript against a real Music app. It triggers the automation
permission prompt on your terms rather than mid-party, and it checks your
library is untouched at the end.

<details>
<summary>If you really do end up with a ZIP</summary>

```bash
cd ~/Downloads/apple-music-jukebox-main && chmod +x start.command && xattr -dr com.apple.quarantine .
```

The `chmod` puts the executable bit back; the `xattr` clears the download
quarantine. Without both, double-clicking `start.command` does nothing useful.
</details>

---

## THE PARTY CHECKLIST

Work down this list. The first four are the ones that actually ruin parties.

1. **Autoplay ON, crossfade OFF.**
   In Music, open **Playing Next** (top right) and make sure the **∞** button
   is lit. Autoplay is what keeps music going when nobody has picked anything.
   Then **Music → Settings → Playback** and turn **Crossfade Songs OFF** —
   crossfade overlaps the handoff and you get two songs at once.

2. **Approve the automation prompt.**
   The first time the jukebox talks to Music, macOS asks whether Terminal may
   control Music. Say yes. If you miss it:
   **System Settings → Privacy & Security → Automation → Terminal → Music**.
   Run `node preflight.js` once in advance to trigger it on your terms.

3. **Allow incoming connections.**
   **System Settings → Network → Firewall**. Either turn it off for the night
   or allow incoming connections for Node. Without this, phones cannot reach
   the laptop and nothing a guest taps will work.

4. **Guests must be on the SAME Wi-Fi as the laptop.**
   Not the guest network. Many routers isolate guest clients from each other,
   which silently blocks every phone. If picks fail from phones but work on
   the laptop, this is why.

5. **Plug the laptop into power.** `start.command` keeps the Mac and the
   display awake for as long as it runs, which flattens a battery fast.

6. **Do a full dry run tonight.** Queue three songs, let the queue run dry
   into Autoplay, then pick again and confirm the pick starts right after the
   Autoplay song ends.

---

## Running it

### The Dock app

**You already have it** — it came down with the clone. There is nothing to
download and nothing to install.

Open the folder in Finder:

```bash
open ~/Developer/apple-music-jukebox
```

Drag **Jukebox.app** onto the Dock, then right-click it there and pick
**Options → Keep in Dock**.

Or let the Mac do it for you:

```bash
defaults write com.apple.dock persistent-apps -array-add "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$HOME/Developer/apple-music-jukebox/Jukebox.app</string><key>_CFURLStringType</key><integer>0</integer></dict></dict></dict>" && killall Dock
```

If Finder shows it as a plain folder instead of an app, it just has not
noticed yet — `touch ~/Developer/apple-music-jukebox/Jukebox.app` and it will.

**To put it in a particular spot** (handy for making a second Mac match the
first), positions count app icons from the left starting at 1:

```bash
./tools/add-to-dock.command 3
```

To see what order a Dock is in now:

```bash
defaults export com.apple.dock - | python3 -c "import plistlib,sys;print(' | '.join('%d:%s'%(i+1,e['tile-data']['file-label']) for i,e in enumerate(plistlib.loads(sys.stdin.buffer.read()).get('persistent-apps',[]))))"
```

### A second Mac

```bash
git clone https://github.com/woody438/apple-music-jukebox.git ~/Developer/apple-music-jukebox
```

Then check Node is there:

```bash
node -v
```

**`command not found: node`?** This installs it either way — Homebrew if you
have it, the official package if you don't. It will ask for your Mac password
if it takes the second route:

```bash
if command -v brew >/dev/null 2>&1; then brew install node; else VER=$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c "import json,sys;print([r for r in json.load(sys.stdin) if r.get('lts')][0]['version'])"); echo "Installing Node $VER..."; curl -fL --progress-bar "https://nodejs.org/dist/$VER/node-$VER.pkg" -o /tmp/node.pkg && sudo installer -pkg /tmp/node.pkg -target / && /usr/local/bin/node -v; fi
```

The macOS installer is a **universal** package named `node-vX.Y.Z.pkg`, with
no architecture in the name. The `-darwin-arm64` suffix belongs to the
`.tar.gz` archives only, and using it on the `.pkg` gets you a 404.

Both routes put Node where `Jukebox.app` looks for it (`/opt/homebrew/bin`
or `/usr/local/bin`), which matters: an app launched from the Dock gets a
bare `PATH` and cannot see your shell's.

Then:

```bash
cd ~/Developer/apple-music-jukebox && node preflight.js && ./tools/add-to-dock.command
```

**Run preflight on the new machine too.** It is a different Mac: it needs its
own "control Music" permission, its own Node, and its own check that nothing
in your library trips it up. Do not assume it works because the first one did.

Two things that catch people out:

- **Persistent IDs are per-library, not per-account.** Even with the same
  iCloud Music Library, a track's ID differs between Macs. Nothing transfers
  between them — each builds its own index, and a queue saved on one is
  meaningless on the other. (`data/` is not in git, so this sorts itself out.)
- **Do not run both at once on the same Wi-Fi.** Guests scan whichever QR
  code is in front of them, and half the picks end up on a laptop that is not
  plugged into the PA. One jukebox per party.

- **Double-click: starts.** It opens Music if it isn't open, starts the
  server, stops the Mac sleeping, and opens the jukebox in your browser.
- **Double-click again: stops.**

There is no "are you sure" on stopping, on purpose. Stopping the jukebox
does **not** stop Music — the room keeps playing whatever is on — and
starting it again restores the queue, so a mis-click costs one more click.
A confirmation dialog would need its own permission and could fail quietly,
which is worse at a party.

If it ever refuses to start, the reason is in `data/jukebox.log`.

**It leaves nothing on screen while it runs**, so it caps how long it keeps
the Mac awake at 12 hours — long enough to outlast any party, short enough
that a jukebox forgotten overnight does not flatten the battery. Override
with `AWAKE_LIMIT_SECONDS` if you need to.

### Updating

Double-click **`Update.command`**. It refuses to run while the jukebox is up,
pulls the latest, and then runs the engine tests so you see green before you
trust it. If the tests fail it tells you how to go back.

There is **no automatic updater**, on purpose. An updater exists to change the
code, and on the one night this matters that is risk with no upside. Update
when you choose to, not mid-party.



### On the night

Double-click **`start.command`**. It checks Node, opens Music if it is not
already running, starts the server, keeps the Mac awake, and opens the
jukebox in your browser.

Then press **control-command-F** for full screen.

Stop it with **control-C** in the Terminal window it opened.

### Before the night: preflight

```bash
node preflight.js
```

Checks everything against the real Music app and prints PASS/FAIL per step.
It works in its own **"Jukebox Preflight"** playlist, and it confirms your
library has exactly as many tracks at the end as it did at the start.

It plays about five seconds of audio, and asks first.

```bash
node preflight.js --no-audio   # skip the playback step
node preflight.js --yes        # do not ask
```

### Try the UI with no Mac at all

`demo/jukebox-demo.html` is the whole interface in one self-contained file —
the real markup, the real stylesheet, the embedded fonts — with a simulated
player and a 338-track demo library baked in. Open it straight off disk, or
scan the QR code on screen to pull it up on your phone.

```bash
open demo/jukebox-demo.html
```

A **DEMO** tag in the bottom corner holds a clock-speed control and a
"jump to end of song" button, so you can watch the handoff and the run into
Autoplay in seconds rather than minutes.

**It proves nothing about the Music integration** — there is no Music app
behind it. `preflight.js` is what proves that. Rebuild it after changing the
UI with `node demo/build.js`.

### Without a Mac, or without touching your library: mock mode

```bash
MOCK=1 node server.js
```

A simulated Music app with a fake 2,000-song library and short tracks. Nothing
is played, nothing is touched. Good for showing someone the UI.

```bash
node test/mock-suite.js        # the engine test suite, no Mac needed
```

### The dry run

With the server running in another window — mock or real:

```bash
node test/party-rehearsal.js
```

It queues three songs as the laptop and one as a phone, lets the queue run dry
into Autoplay, picks again, and confirms the pick does not cut the Autoplay
song off and starts the moment it ends. Add `--fast` against a real library,
or you will sit through four whole songs.

---

## Finding something in a big library

Three ways in, in the order a guest will reach for them:

1. **Genre buttons** across the top — the lit category buttons off the front
   of the real cabinets. Tap one and the strips underneath become that genre.
   Each shows its track count. They are ordered biggest first, and the long
   tail of one-track genres rolls up into **OTHER** so the bar stays usable.
   `MAX_GENRE_BUTTONS` at the top of `public/app.js` controls how many get
   their own button (default 18).

   Genres are merged case-insensitively, so `Rock` and `rock` are one button.
   Separators are left alone — deciding that `Hip-Hop` and `Hip Hop` are the
   same thing is an opinion about your tags, not ours to impose.

   **To choose the genres yourself: press ⌃⌥G** (control-option-G) on the
   laptop. Or click the small **gear icon** at the right-hand end of the genre
   bar, just before the SEARCH button — it is only there on the laptop, never
   on a phone. Tick whichever you want.
   The choice is held on the server, so the phones follow it immediately, and
   it survives a restart. Anything unticked is still reachable through
   **OTHER** and through search. "Biggest 18 automatically" puts it back.

2. **The A–Z rail** along the bottom jumps by artist, and it tracks whichever
   genre you are in — a genre with no Q artists greys its Q out.

3. **Search**, behind the chrome **SEARCH** button. You don't search a
   jukebox, you thumb through one, so it is one tap away rather than taking
   pride of place. Typing anywhere on the laptop opens it anyway.

   **Search always covers the whole library, never just the selected genre.**
   Searching drops you back to ALL, and tapping a genre clears the search.
   They are two ways of narrowing the same thing, so only one applies at a
   time — "I searched for my song and it wasn't there" is the worst thing
   that can happen to a guest.

### Attract mode

Leave the laptop alone for 30 seconds and the cabinet starts thumbing through
itself — a page every 8 seconds, moving on to the next genre when it reaches
the end of one. The page counter reads **BROWSING** while it does. Any touch,
tap or keypress stops it instantly. It never runs on phones, and never while
a confirm card or the search drawer is open.

After 90 seconds idle the laptop also resets itself back to ALL with the
search cleared, so nobody walks up to the last guest's leftovers.

Both are constants at the top of `public/app.js`: `ATTRACT_IDLE_MS`,
`ATTRACT_STEP_MS`, `IDLE_RESET_MS`.

---

## Host controls (laptop only)

Host endpoints only answer requests from the laptop itself. Phones can never
reach them, so nobody can skip your song from the kitchen.

| Keys | Does |
|---|---|
| **⌃⌥→** | Skip — next pick if one is queued, otherwise Music's next track |
| **⌃⌥Space** | Play / pause (also sets and clears hold) |
| **⌃⌥↑ / ⌃⌥↓** | Volume ±10 |
| **⌃⌥⌫** | Remove the last queued pick |
| **⌃⌥H** | Host panel — queue, remove, clear, volume, re-index, last error |
| **⌃⌥G** | **Choose which genres get a button** (or click the gear on the genre bar) |
| **⌃⌥R** | Re-index the library |
| **⌃⌥F** | Full screen |

> **Hotkey clash:** Rectangle and Magnet both use **⌃⌥←/→** for window
> snapping by default, which collides with skip. `preflight.js` checks whether
> either is installed. If it is, quit it for the party or change `MODIFIER` at
> the top of `public/app.js`.

The hardware media keys on the keyboard still control Music directly, and the
engine handles that: pausing with the media key sets **hold**, so picks queue
up but nothing starts until you press play again.

---

## If something goes wrong

| What you see | Almost certainly | Do this |
|---|---|---|
| Preflight fails at "control Music" | The automation permission was never granted | System Settings → Privacy & Security → Automation → your Terminal → tick **Music**, then run preflight again |
| Preflight fails on a `scripts/` step | A property name differs on your macOS version | Send me the exact PASS/FAIL output. (Passed 17/17 on macOS 25.6 / Node 26.8 over a 13,375-track library.) |
| Phones can't load the page at all | Firewall, or they're on the guest Wi-Fi | Checklist items 3 and 4. Test by loading the URL on your own phone first |
| The QR code shows an address phones can't reach | **This Mac has two network adapters** and the jukebox advertised the wrong one | See below — pin the right one in `jukebox.conf` |
| Phones load but every pick fails | Same Wi-Fi, but client isolation is on | Move everyone to the main network, not the guest one |
| Two songs overlap at the handoff | Crossfade is on | Music → Settings → Playback → Crossfade Songs **off** |
| Music stops dead when the queue runs out | Autoplay (∞) is off | Open Playing Next in Music and light up the **∞** |
| A pick plays but then silence | The track was unchecked or cloud-unavailable | It should have been excluded. Re-index with ⌃⌥R and tell me |
| ⌃⌥→ does nothing | Rectangle or Magnet has that shortcut | Quit it for the night, or change `MODIFIER` at the top of `public/app.js` |
| Laptop goes to sleep mid-party | You started the server by hand, not via `start.command` | `start.command` runs `caffeinate` tied to the server. Use it |
| Queue looks wrong after a restart | It restores from `data/state.json` | ⌃⌥H → Clear queue, and it rebuilds from scratch |

The host panel (**⌃⌥H**) shows the last error the engine hit. That's the first
place to look when something is off.

### Two network adapters

A Mac with both Ethernet and Wi-Fi has two addresses, and only one of them is
on the network the phones are using. The jukebox follows the routing table —
the adapter the Mac actually sends traffic out of — and prints every address
it found at startup, marking the one it chose. If that's the wrong one, don't
unplug anything; just pin the right one.

Find the addresses:

```bash
for i in en0 en1 en2 en3 en4; do ip=$(ipconfig getifaddr $i 2>/dev/null) && echo "$i = $ip"; done
```

Pin it, so the Dock app uses it too (an app launched from the Dock has no
shell, so an environment variable set in Terminal never reaches it):

```bash
cd ~/Developer/apple-music-jukebox && cp jukebox.conf.example jukebox.conf && open -e jukebox.conf
```

Uncomment the `PUBLIC_URL` line, put the right address in, save, and restart
the jukebox. `jukebox.conf` is per-machine and is not tracked by git.

---

## Guest rules

Set at the top of `server.js`:

| Rule | Default | Change it with |
|---|---|---|
| Queued picks per phone | 3 | `JUKEBOX_MAX_PER_PHONE` |
| Queued picks for the laptop | 10 | `JUKEBOX_MAX_PER_LAPTOP` |
| Maximum queue length | 60 | `JUKEBOX_MAX_QUEUE` |
| No repeat within | 60 minutes (the laptop is exempt) | `JUKEBOX_REPEAT_MINUTES`, `0` turns it off |
| No duplicate of the playing or a queued song | always | — |

Set any of them in `jukebox.conf` (copy `jukebox.conf.example`) and restart.
The startup log prints the rules in force.

**The cap is on songs still WAITING.** Once a song starts playing it has left
the queue and freed its slot, so everyone gets another turn as the night goes.

**"Why can I only queue 3 on the laptop?"** The laptop only counts as the
laptop when the browser is at **`http://localhost:8484/`**. Open it by the
machine's LAN address instead — by scanning your own QR code, say — and the
server sees an ordinary guest and applies the phone limit. If **⌃⌥H** does
not open the host panel, that window is not being treated as the host.

---

## What is excluded from the index

Only media kind **song** is indexed. Also dropped:

- tracks whose checkbox is **unchecked** — Music skips these in playlists, so
  a guest picking one would get silence
- tracks whose cloud status is **ineligible, removed, error, no longer
  available** or **prerelease**

The host panel shows how many of each were dropped.

---

## Configuration

Environment variables, all optional:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8484` | Avoid 5000 and 7000 — AirPlay Receiver uses those |
| `JUKEBOX_TITLE` | `JUKEBOX` | The neon marquee text |
| `JUKEBOX_PLAYLIST` | `Jukebox` | The playlist the queue mirrors into |
| `PUBLIC_URL` | auto | Override the QR URL if the detected address is wrong |
| `MOCK` | — | `1` for the simulator |

---

## Licences

- **Monoton** and **Oswald** — SIL Open Font License 1.1
  (`assets/fonts/LICENSE-*.txt`), embedded as base64 in `public/fonts.css`
- **qrcode-generator** by Kazuhiko Arase — MIT (`public/vendor/qrcode.js`)

No brand names or logos are used anywhere in the UI.
