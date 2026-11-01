'use strict';

// jukebox.conf, read and written for the Mac app's Settings window.
//
// The file stays what it has always been: shell, sourced by `set -a; .
// jukebox.conf` before the server starts. The window is a second way to
// edit it, never a second format -- so the server, the git install's
// launchers and anyone with TextEdit all go on agreeing about what it says.
//
// READING asks /bin/sh, because only the shell knows what a line like
//   JUKEBOX_WIFI_PASSWORD='it'\''s $5'
// means. Parsing that here would be a second reader that disagrees with
// the real one on exactly the passwords that matter.
//
// WRITING touches only the lines that set a key the window manages:
// comments, blank lines and anything hand-written stay as they were. Every
// value is written in single quotes (the one shell quoting with no special
// characters inside), the file is read back through the shell, and if any
// value does not come back exactly as asked the old file is put back and
// the save refused. A value equal to its default is removed rather than
// written, so the file only says what differs.
//
//   node lib/conf.js read  FILE            -> {"ok":true,"values":{...},"defaults":{...}}
//   node lib/conf.js write FILE < JSON     -> {"ok":true} | {"ok":false,"errors":{KEY:why}}
//
// Zero dependencies, like everything else here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { RESERVED_PLAYLIST_NAMES } = require('./music');

// Every key the window manages, with the default server.js applies when it
// is unset. test/conf-suite.js checks these against server.js's own.
const DEFAULTS = {
  JUKEBOX_TITLE: 'JUKEBOX',
  JUKEBOX_PLAYLIST: 'Jukebox',
  JUKEBOX_MAX_PER_PHONE: '25',
  JUKEBOX_MAX_PER_LAPTOP: '25',
  JUKEBOX_MAX_QUEUE: '60',
  JUKEBOX_REPEAT_MINUTES: '60',
  JUKEBOX_WIFI_NAME: '',
  JUKEBOX_WIFI_PASSWORD: '',
  PUBLIC_URL: '',
};
const KEYS = Object.keys(DEFAULTS);

const MARKER = '# --- set from the Party Jukebox Settings window ---';

function shellQuote(v) {
  return "'" + String(v).replace(/'/g, "'\\''") + "'";
}

// What the shell makes of the file. Run with a bare environment, so nothing
// set where the app was launched leaks into what the file "says".
function readConf(file) {
  const values = Object.assign({}, DEFAULTS);
  if (!fs.existsSync(file)) return { ok: true, values, defaults: DEFAULTS, exists: false };
  try {
    execFileSync('/bin/sh', ['-n', file], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  } catch (e) {
    return { ok: false, error: 'jukebox.conf has a mistake in it: ' + firstLine(e.stderr) };
  }
  // For each key: whether it is set, then its value, NUL-separated (NUL is the
  // one byte a shell variable cannot hold, so no value can break the framing).
  const script = '. "$1" >/dev/null 2>&1 || exit 3\n' +
    KEYS.map((k) => `printf '%s\\0%s\\0' "\${${k}+1}" "\${${k}-}"`).join('\n');
  let out;
  try {
    out = execFileSync('/bin/sh', ['-c', script, 'jukebox-conf', file], {
      env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME || '/' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, error: 'jukebox.conf could not be read: ' + (firstLine(e.stderr) || 'exit ' + e.status) };
  }
  const parts = out.toString('utf8').split('\0');
  KEYS.forEach((k, i) => {
    if (parts[2 * i] === '1') values[k] = parts[2 * i + 1];
  });
  return { ok: true, values, defaults: DEFAULTS, exists: true };
}

function firstLine(buf) {
  return String(buf || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
}

// Per-key reasons a value would not work, in words for the window.
function validate(values) {
  const errors = {};
  const v = (k) => (values[k] === undefined || values[k] === null ? DEFAULTS[k] : String(values[k]));
  for (const k of KEYS) {
    if (/[\n\r\0]/.test(v(k))) errors[k] = 'Must be on one line.';
  }
  for (const k of ['JUKEBOX_MAX_PER_PHONE', 'JUKEBOX_MAX_PER_LAPTOP', 'JUKEBOX_MAX_QUEUE', 'JUKEBOX_REPEAT_MINUTES']) {
    if (!/^\d{1,4}$/.test(v(k).trim())) errors[k] = 'A whole number from 0 to 9999.';
  }
  if (!errors.JUKEBOX_MAX_QUEUE && Number(v('JUKEBOX_MAX_QUEUE')) < 1) errors.JUKEBOX_MAX_QUEUE = 'At least 1, or nobody can pick.';
  if (v('JUKEBOX_TITLE').trim().length > 40) errors.JUKEBOX_TITLE = 'At most 40 characters: it has to fit the marquee.';
  const pl = v('JUKEBOX_PLAYLIST').trim();
  if (pl && RESERVED_PLAYLIST_NAMES.has(pl.toLowerCase())) errors.JUKEBOX_PLAYLIST = `"${pl}" is one of Music's own; pick another name.`;
  const url = v('PUBLIC_URL').trim();
  if (url && !/^https?:\/\/[^\s/]+(:\d+)?(\/\S*)?$/.test(url)) errors.PUBLIC_URL = 'A web address like http://192.168.1.40:8484/, or empty.';
  const name = v('JUKEBOX_WIFI_NAME');
  const pass = v('JUKEBOX_WIFI_PASSWORD');
  if (Buffer.byteLength(name, 'utf8') > 32) errors.JUKEBOX_WIFI_NAME = 'Wi-Fi names are at most 32 bytes.';
  if (pass && (pass.length < 8 || pass.length > 63)) errors.JUKEBOX_WIFI_PASSWORD = 'Wi-Fi passwords are 8 to 63 characters.';
  if (pass && !name) errors.JUKEBOX_WIFI_NAME = 'Needed when there is a password.';
  return errors;
}

// Normalise what the window sent: trimmed where trimming is safe (never a
// password or a Wi-Fi name: spaces there are real), defaults for anything absent.
function normalise(values) {
  const out = {};
  for (const k of KEYS) {
    let v = values[k] === undefined || values[k] === null ? DEFAULTS[k] : String(values[k]);
    if (k !== 'JUKEBOX_WIFI_PASSWORD' && k !== 'JUKEBOX_WIFI_NAME') v = v.trim();
    if (/^JUKEBOX_(MAX_|REPEAT)/.test(k) && /^\d+$/.test(v)) v = String(Number(v));   // "025" -> "25"
    if ((k === 'JUKEBOX_TITLE' || k === 'JUKEBOX_PLAYLIST') && v === '') v = DEFAULTS[k];
    out[k] = v;
  }
  return out;
}

const assignment = (k) => new RegExp(`^\\s*(export\\s+)?${k}=`);

// The new text of the file: the CHANGED keys updated in place, every other
// line untouched -- including a key set by a command, such as
//   PUBLIC_URL="http://$(ipconfig getifaddr en1):8484/"
// which reads as one address today and must not be frozen into it by a save
// that was only about the Wi-Fi.
function render(text, wanted, changed) {
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const out = [];
  const placed = new Set();
  for (const line of lines) {
    const k = KEYS.find((key) => assignment(key).test(line));
    if (!k || !changed.has(k)) { out.push(line); continue; }
    if (placed.has(k)) continue;                       // a later duplicate: the shell would let it win; drop it
    placed.add(k);
    if (wanted[k] !== DEFAULTS[k]) out.push(`${k}=${shellQuote(wanted[k])}`);
  }
  const missing = KEYS.filter((k) => changed.has(k) && !placed.has(k) && wanted[k] !== DEFAULTS[k]);
  if (missing.length) {
    if (!out.includes(MARKER)) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(MARKER);
    }
    for (const k of missing) out.push(`${k}=${shellQuote(wanted[k])}`);
  }
  return out.join('\n') + '\n';
}

function writeConf(file, values, { example } = {}) {
  const wanted = normalise(values || {});
  const errors = validate(wanted);
  if (Object.keys(errors).length) return { ok: false, errors };

  const had = fs.existsSync(file);
  const current = readConf(file);
  if (!current.ok) return current;                     // a broken file is shown, not overwritten
  const changed = new Set(KEYS.filter((k) => wanted[k] !== current.values[k]));
  if (!changed.size) return { ok: true, values: wanted, unchanged: true };
  const before = had ? fs.readFileSync(file, 'utf8')
    : (example && fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '');
  const after = render(before, wanted, changed);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, after, { mode: 0o600 });       // it can hold the Wi-Fi password
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);

  // Read it back the way the server will, and undo the save if anything differs.
  const check = readConf(file);
  const wrong = check.ok ? KEYS.filter((k) => check.values[k] !== wanted[k]) : KEYS;
  if (wrong.length) {
    if (had) fs.writeFileSync(file, before, { mode: 0o600 }); else fs.unlinkSync(file);
    return { ok: false, error: `Saving would have changed ${wrong.join(', ')} -- the old settings were kept.` };
  }
  return { ok: true, values: wanted };
}

module.exports = { DEFAULTS, KEYS, MARKER, shellQuote, readConf, writeConf, validate, normalise, render };

if (require.main === module) {
  const [cmd, file, example] = process.argv.slice(2);
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  if (cmd === 'read' && file) {
    say(readConf(file));
  } else if (cmd === 'write' && file) {
    let input = '';
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => {
      let values;
      try { values = JSON.parse(input || '{}'); } catch (e) { say({ ok: false, error: 'bad JSON from the app' }); return; }
      try { say(writeConf(file, values, { example })); } catch (e) { say({ ok: false, error: e.message }); }
    });
  } else {
    process.stderr.write('usage: conf.js read FILE | write FILE [EXAMPLE] < JSON\n');
    process.exit(2);
  }
}
