# Party Jukebox

A jukebox web UI that drives the **Music app** on a Mac. The laptop shows a
1950s cabinet full-screen; guests pick songs from their phones over the same
Wi-Fi by scanning a QR code. Picks play in order, first come first served.
When the picks run out, Music's own Autoplay keeps the room going.

Your library only. No Apple Developer account, no MusicKit, no Apple Music API.
Zero npm dependencies, no build step, nothing fetched from the internet at
run time — the fonts and the QR library are in the repo.

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

### Without a Mac, or without touching your library: mock mode

```bash
MOCK=1 node server.js
```

A simulated Music app with a fake 2,000-song library and short tracks. Nothing
is played, nothing is touched. Good for showing someone the UI.

```bash
node test/mock-suite.js        # the engine test suite, no Mac needed
```

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

## Guest rules

Set at the top of `server.js`:

| Rule | Default |
|---|---|
| Queued picks per phone | 3 |
| Queued picks for the laptop | 10 |
| Maximum queue length | 60 |
| No repeat within | 60 minutes (the host is exempt) |
| No duplicate of the playing or a queued song | always |

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
