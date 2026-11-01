# Party Jukebox

A jukebox for your Mac's **Music** app. The laptop shows a 1950s cabinet
full-screen; guests pick songs from their phones by scanning a QR code on the
same Wi-Fi. Picks play in order, first come first served. When the picks run
out, Music's own Autoplay keeps the room going.

Your library only. No Apple Developer account, no MusicKit, no Apple Music
API, no account of any kind, and nothing fetched from the internet while it
runs.

---

## Download

**[Download Party Jukebox](https://github.com/woody438/apple-music-jukebox/releases/download/latest/PartyJukebox.zip)** (about 45 MB)

Needs a Mac with an **Apple chip** (M1 or later) and **macOS 14** or later.
Everything it needs is inside it: nothing else to install.
[All builds and notes](https://github.com/woody438/apple-music-jukebox/releases/tag/latest).

1. Unzip it and drag **Party Jukebox** into **Applications**.
2. Open it. The first time, macOS blocks it, because it isn't notarised by
   Apple. Open **System Settings ▸ Privacy & Security**, scroll down, and
   click **Open Anyway**. You only ever do this once.
3. The jukebox starts and its page opens in your browser. A **♪** appears in
   the menu bar, and Party Jukebox in the Dock.
4. At the first song, macOS asks whether **Party Jukebox may control Music**.
   Allow it — that is how it plays your guests' picks. It is asked once:
   updates are signed with the same certificate, so macOS knows them as the
   same app.

Then work down [the party checklist](#the-party-checklist).

---

## Using it

**Everything is in the ♪ menu** in the menu bar:

| Item | Does |
|---|---|
| **Jukebox is running**, **Guests: 192.168.1.40:8484** | Whether it's on, and the exact address on the QR code |
| **Open Jukebox Page** | The cabinet, at `http://localhost:8484/` — always localhost, so you get the host controls |
| **Start / Stop / Restart Jukebox** | Stopping leaves Music playing whatever is on; starting again brings the queue back |
| **Guest Network** | Which network adapter the QR code points at — see [two network adapters](#two-network-adapters) |
| **Check for Updates…** / **Install Update** | See [updates](#updates) |
| **Settings…** (⌘,) | Everything below, as controls |
| **Show Log** | What the jukebox has been doing, for when something's off |
| **Quit Party Jukebox** | Stops the jukebox. Music carries on playing |

Clicking the Dock icon opens the jukebox page (or starts the jukebox if it
was stopped). While the jukebox runs, the Mac doesn't sleep and the display
stays on — so plug the laptop in.

### Settings

**♪ ▸ Settings…** (or ⌘, while Party Jukebox is in front):

| Tab | What's in it |
|---|---|
| **General** | The marquee title on the cabinet · the name of the Music playlist the queue lives in · start the jukebox when the app opens · open the app at login |
| **Guests** | How many songs each phone, the laptop, and everyone together may have waiting · minutes before the same song can be picked again (0 = no rule) |
| **Wi-Fi Code** | A second QR code that joins phones to your Wi-Fi — see [Wi-Fi QR code](#wi-fi-qr-code) |
| **Network** | Which address guests are given, and a fixed address for unusual networks |
| **Updates** | Status, Check Now, preview builds, and the settings file and data folder |

If a value won't work, it says why beside the field and nothing is saved.
Most settings are read when the jukebox starts, so after saving one the
window offers **Restart Jukebox Now** — the queue is kept and Music carries
on playing. Guest Network changes apply at once.

Settings, the queue and the log live in
`~/Library/Application Support/Party Jukebox`. The settings themselves are
an ordinary text file there, `jukebox.conf`, which the window reads and
writes; you never need to touch it.

### Updates

Party Jukebox looks for a new build when it opens and every four hours. When
there is one, it **asks** — it never installs by itself, and if the jukebox
is playing it tells you that installing restarts it for about ten seconds
(the queue is kept, Music keeps playing). Say **Install** and it downloads,
checks the download is really signed by this project, quits, updates and
reopens.

**Check for updates before a party, not during one.**

---

## THE PARTY CHECKLIST

Work down this list. The first four are the ones that actually ruin parties.

1. **Autoplay ON, crossfade OFF.**
   In Music, open **Playing Next** (top right) and make sure the **∞** button
   is lit. Autoplay is what keeps music going when nobody has picked anything.
   Then **Music → Settings → Playback** and turn **Crossfade Songs OFF**.
   Off is still the cleanest: every pick plays to within a second of its end.
   If you leave it on, the jukebox copes. It measures how early Music moves
   on (from the first song that changes by itself, usually an Autoplay one)
   and hands over to the next pick that many seconds early, so Music never
   gets to slip its own song in. The price is that each pick loses its last
   few seconds, and until that first measurement the very first change of
   the night can still show a moment of the wrong song.

2. **Allow Party Jukebox to control Music.**
   macOS asks the first time the jukebox talks to Music. If you missed it or
   said no: **System Settings → Privacy & Security → Automation → Party
   Jukebox → Music**, switched on.

3. **Allow incoming connections.**
   If the macOS firewall is on (**System Settings → Network → Firewall**),
   allow incoming connections when it asks about Party Jukebox (it may name
   it **node**). Without this, phones cannot reach the laptop and nothing a
   guest taps will work.

4. **Guests must be on the SAME Wi-Fi as the laptop.**
   Not the guest network. Many routers isolate guest clients from each other,
   which silently blocks every phone. If picks fail from phones but work on
   the laptop, this is why. To save everyone asking for the password, turn on
   the [Wi-Fi QR code](#wi-fi-qr-code).

5. **Plug the laptop into power.** The Mac and its display stay awake for as
   long as the jukebox runs, which flattens a battery fast.

6. **Do a full dry run.** Queue three songs, let the queue run dry into
   Autoplay, then pick again and confirm the pick starts right after the
   Autoplay song ends. Scan the QR code with your own phone too.

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
> snapping by default, which collides with skip. If you use either, quit it
> for the party.

The hardware media keys on the keyboard still control Music directly, and the
engine handles that: pausing with the media key sets **hold**, so picks queue
up but nothing starts until you press play again.

---

---

## If something goes wrong

| What you see | Almost certainly | Do this |
|---|---|---|
| macOS says Party Jukebox "can't be opened" | It isn't notarised by Apple | System Settings → Privacy & Security → **Open Anyway**. Once only |
| No songs play; the log says it can't control Music | The Music permission was refused | Checklist item 2 |
| Phones can't load the page at all | Firewall, or they're on the guest Wi-Fi | Checklist items 3 and 4. Test by loading the address on your own phone first |
| The QR code shows an address phones can't reach | **This Mac has two network adapters** and the jukebox picked the wrong one | ♪ → **Guest Network** → the other adapter. See below |
| No ♪ in the menu bar | Party Jukebox isn't open, or the menu bar is too crowded (behind the notch) | Open it from Applications. On a MacBook with a notch, quit another menu bar app |
| Phones load but every pick fails | Same Wi-Fi, but client isolation is on | Move everyone to the main network, not the guest one |
| Two songs overlap at the handoff | Crossfade is on | Music → Settings → Playback → Crossfade Songs **off** |
| A second of a different song between two picks | Music moved on before the jukebox did | ♪ → Show Log: that pick's line says `RECOVERED`. With crossfade on, look for `Music is leaving tracks Ns early` — once that appears it should stop. If it keeps happening, report it with the log |
| Music stops dead when the queue runs out | Autoplay (∞) is off | Open Playing Next in Music and light up the **∞** |
| A pick plays but then silence | The track was unchecked or cloud-unavailable | It should have been excluded. Re-index with ⌃⌥R and report it |
| ⌃⌥→ does nothing | Rectangle or Magnet has that shortcut | Quit it for the night |
| "Update ready" but Install says it isn't signed | You have a very early test build | Download the app again from the link at the top, once |
| Queue looks wrong after a restart | It is restored from disk | ⌃⌥H → Clear queue, and it rebuilds from scratch |

The host panel (**⌃⌥H** on the cabinet) shows the last error the jukebox hit,
and **♪ → Show Log** shows everything. Those are the first places to look.

### Two network adapters

A Mac with both Ethernet and Wi-Fi — a Mac mini, say — has two addresses, and
only one of them is on the network the phones are using. The jukebox follows
the routing table: the adapter the Mac actually sends traffic out of. If
that's the wrong one, don't unplug anything; just pick the right one.

Click the ♪, look under **Guest Network**, and pick the adapter the phones
are on — *Wi-Fi* or *Ethernet*, each with its address. The QR code on the
cabinet changes straight away, nothing restarts, and the choice is
remembered on that Mac. **Automatic** puts it back. (The same choice is in
**Settings → Network**.)

The choice is an adapter, not an address, so it keeps working when the
router hands out a different address next time. If the chosen adapter loses
its address (cable out, Wi-Fi off), the jukebox falls back to automatic
rather than showing a dead address, and the menu says so.

For an unusual network where neither works, **Settings → Network → Fixed
address** pins an exact web address instead. An adapter picked in the menu
still takes priority over it.

## Wi-Fi QR code

A second code on the laptop screen, above the jukebox one. A guest scans it,
the phone offers to join the network, then they scan the jukebox code. The
iPhone and Android cameras both do this with no app.

**♪ → Settings… → Wi-Fi Code**: switch it on, type the network name and
password, **Save**, then **Restart Jukebox Now**.

- **It must be the network the laptop is on** — checklist item 4.
- **The password is printed under the code** for anyone whose camera won't
  join from a scan. The code holds it in plain text anyway.
- **Only the laptop shows it.** Phones asking the jukebox are told nothing.
- **It stays on this Mac.** The password is kept in the settings file in your
  Library folder, readable by your user only. It is never uploaded anywhere.
- **Scan it with your own phone before the party.** Forget the network on the
  phone first, then scan, so you know it really joins.

---

## Guest rules

All in **Settings → Guests**:

| Rule | Default |
|---|---|
| Songs waiting per phone | 25 |
| Songs waiting for the laptop | 25 |
| Songs waiting in total | 60 |
| No repeat within | 60 minutes (0 turns it off; the laptop is exempt) |
| No duplicate of the playing or a queued song | always |

**The cap is on songs still WAITING.** Once a song starts playing it has left
the queue and freed its slot, so everyone gets another turn as the night goes.

**"Why can I only queue a few on the laptop, and where is the gear?"**
The laptop only counts as the laptop when the browser is at
**`http://localhost:8484/`**. Open it by the Mac's network address instead —
by scanning your own QR code, say — and the jukebox sees an ordinary guest:
the phone limit applies, the genre gear is hidden, and the host hotkeys do
nothing. Press **⌃⌥H** there and it tells you so. **Open Jukebox Page** in
the ♪ menu always opens `localhost`.

---

## What is excluded from the index

Only media kind **song** is indexed. Also dropped:

- tracks whose checkbox is **unchecked** — Music skips these in playlists, so
  a guest picking one would get silence
- tracks whose cloud status is **ineligible, removed, error, no longer
  available** or **prerelease**

The host panel shows how many of each were dropped.

---

---

## For developers

The app is a native Swift shell (`app/`) around a zero-dependency Node
server (`server.js`, `lib/`, `public/`, `scripts/`) that drives Music with
AppleScript and JXA. `CLAUDE.md` is the engineering notebook: read it before
changing the engine.

```bash
git clone https://github.com/woody438/apple-music-jukebox.git && cd apple-music-jukebox
```

**No Mac, or no wish to touch your library — mock mode.** A simulated Music
with a fake library and short tracks; nothing is played or touched:

```bash
MOCK=1 node server.js
```

**Tests** (no Mac needed, except where noted):

```bash
node test/mock-suite.js        # the queue engine
```

```bash
node test/conf-suite.js        # the Settings window's reading and writing of jukebox.conf
```

```bash
node test/network-suite.js     # which address guests get, and changing it live
```

```bash
node test/ui-suite.js /tmp/shots    # the cabinet in a browser (needs Playwright; start a mock server first)
```

```bash
node test/party-rehearsal.js   # end to end against a running server, mock or real (--fast for a real library)
```

**Against the real Music app, on a Mac:** `node preflight.js` checks every
script in `scripts/` against your library, in its own "Jukebox Preflight"
playlist, and confirms the library is untouched at the end. It plays about
five seconds of audio and asks first (`--no-audio`, `--yes`).

**The UI with no server at all:** `demo/jukebox-demo.html` is the whole
interface in one file with a simulated player — `open demo/jukebox-demo.html`.
Rebuild it after a UI change with `node demo/build.js`. It proves nothing
about Music.

**Building and releasing the app.** Every pull request is built on GitHub's
Mac runners (`.github/workflows/build-app.yml`): the suites run on the exact
Node the app ships, the built app is launched and smoke-tested, signed, and
published as the [preview](https://github.com/woody438/apple-music-jukebox/releases/tag/preview)
pre-release. **Merging to `main` publishes the
[latest](https://github.com/woody438/apple-music-jukebox/releases/tag/latest) release, and every installed copy is
offered it** — so nothing goes to `main` that wasn't green on its pull
request. To build locally: `brew install xcodegen && cd app && xcodegen
generate`, then open `PartyJukebox.xcodeproj` (it needs `tools/app/` to add
Node and the jukebox; see `.github/workflows/build-app.yml`).

---

## Licences

- **Node.js** — MIT, bundled inside the app (`node-LICENSE` in its Resources)
- **Monoton** and **Oswald** — SIL Open Font License 1.1
  (`assets/fonts/LICENSE-*.txt`), embedded as base64 in `public/fonts.css`
- **qrcode-generator** by Kazuhiko Arase — MIT (`public/vendor/qrcode.js`)

No brand names or logos are used anywhere in the UI.
