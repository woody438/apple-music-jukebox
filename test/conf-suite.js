'use strict';

// lib/conf.js: the Settings window's reader and writer for jukebox.conf.
//   node test/conf-suite.js        (ONLY=<text> for a subset)
//
// The failures that matter are quiet ones: a Wi-Fi password the shell reads
// differently from what was typed, a save that eats a hand-written line, a
// default the window believes that the server does not. Each has a test.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const conf = require('../lib/conf');
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'lib', 'conf.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-conf-'));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// What the server process would actually be handed: the file sourced the way
// both launchers and the app source it, then the environment read by Node.
function asTheServerSeesIt(file) {
  const out = execFileSync('/bin/sh', ['-c', 'set -a; . "$1"; set +a; exec "$2" -e "process.stdout.write(JSON.stringify(process.env))"',
    'x', file, process.execPath], { env: { PATH: '/usr/bin:/bin' } });
  return JSON.parse(out.toString('utf8'));
}

// 1 ------------------------------------------------------------------------
test('the defaults are the server\'s own, and the keys are the names it reads', () => {
  // server.js logs as it loads, so the CONFIG line is tagged and fished out.
  const probe = (env) => {
    const out = execFileSync(process.execPath, ['-e',
      'const s = require(process.argv[1]); process.stdout.write("\\nCONFIG " + JSON.stringify(s.CONFIG) + "\\n"); process.exit(0)',
      path.join(ROOT, 'server.js')], { env: Object.assign({ PATH: process.env.PATH, MOCK: '1' }, env), stdio: ['ignore', 'pipe', 'ignore'] });
    const line = out.toString('utf8').split('\n').find((l) => l.startsWith('CONFIG '));
    return JSON.parse(line.slice(7));
  };
  const plain = probe({});
  const d = conf.DEFAULTS;
  assert.equal(plain.title, d.JUKEBOX_TITLE);
  assert.equal(plain.playlistName, d.JUKEBOX_PLAYLIST);
  assert.equal(String(plain.maxPerDevice), d.JUKEBOX_MAX_PER_PHONE);
  assert.equal(String(plain.maxPerHost), d.JUKEBOX_MAX_PER_LAPTOP);
  assert.equal(String(plain.maxQueueLength), d.JUKEBOX_MAX_QUEUE);
  assert.equal(String(plain.repeatWindowMin), d.JUKEBOX_REPEAT_MINUTES);
  assert.equal(plain.wifiName, d.JUKEBOX_WIFI_NAME);
  assert.equal(plain.wifiPassword, d.JUKEBOX_WIFI_PASSWORD);
  assert.equal(plain.publicUrl || '', d.PUBLIC_URL);

  // And each key really moves the server: a typo in a key name would
  // otherwise save happily and change nothing.
  const set = probe({
    JUKEBOX_TITLE: 'T', JUKEBOX_PLAYLIST: 'P', JUKEBOX_MAX_PER_PHONE: '3', JUKEBOX_MAX_PER_LAPTOP: '4',
    JUKEBOX_MAX_QUEUE: '5', JUKEBOX_REPEAT_MINUTES: '0', JUKEBOX_WIFI_NAME: 'W', JUKEBOX_WIFI_PASSWORD: 'secret99',
    PUBLIC_URL: 'http://10.0.0.9:8484/',
  });
  assert.deepEqual(
    [set.title, set.playlistName, set.maxPerDevice, set.maxPerHost, set.maxQueueLength, set.repeatWindowMin, set.wifiName, set.wifiPassword, set.publicUrl],
    ['T', 'P', 3, 4, 5, 0, 'W', 'secret99', 'http://10.0.0.9:8484/']);
  assert.equal(conf.KEYS.length, 9, 'a new key needs a line in this test too');
});

// 2 ------------------------------------------------------------------------
test('a Wi-Fi password full of shell characters comes back exactly, to the window and to the server', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  try { fs.unlinkSync('/tmp/pwned-jukebox'); } catch (e) {}     // left by a broken build, if any
  const nasty = [
    "it's $5 \"q\" \\ ; , : `x` $(touch /tmp/pwned-jukebox) ü 🎉",
    "'''",
    '$HOME$PATH',
    '  spaces at both ends  ',
    '!#&*?[]{}<>|~=',
  ];
  for (const pass of nasty) {
    const pw = pass.length < 8 ? pass + 'padding!' : pass;
    const r = conf.writeConf(file, { JUKEBOX_WIFI_NAME: 'Café ☕ Net', JUKEBOX_WIFI_PASSWORD: pw });
    assert.ok(r.ok, JSON.stringify(r));
    const back = conf.readConf(file);
    assert.equal(back.values.JUKEBOX_WIFI_PASSWORD, pw, 'the window reads it back as typed');
    assert.equal(back.values.JUKEBOX_WIFI_NAME, 'Café ☕ Net');
    const env = asTheServerSeesIt(file);
    assert.equal(env.JUKEBOX_WIFI_PASSWORD, pw, 'and the server is handed exactly that');
  }
  assert.ok(!fs.existsSync('/tmp/pwned-jukebox'), 'nothing in a value is ever run');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'readable by its owner only: it holds the password');
});

// 3 ------------------------------------------------------------------------
test('a save changes only the settings that changed, and keeps every other line', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  const original = [
    '# my notes about the party',
    'PORT=8484',
    '',
    'PUBLIC_URL="http://$(echo 10.1.2.3):8484/"     # worked out when it is read',
    "JUKEBOX_TITLE='Woody''s Bar'",
    '  export JUKEBOX_MAX_QUEUE=40',
    'MY_OWN_THING=1',
    '',
  ].join('\n');
  fs.writeFileSync(file, original);

  let r = conf.readConf(file);
  assert.equal(r.values.PUBLIC_URL, 'http://10.1.2.3:8484/', 'read through the shell, command and all');
  assert.equal(r.values.JUKEBOX_TITLE, "Woodys Bar");
  assert.equal(r.values.JUKEBOX_MAX_QUEUE, '40', 'export form read');

  // Change only the per-phone limit, and send everything else back as read.
  r = conf.writeConf(file, Object.assign({}, r.values, { JUKEBOX_MAX_PER_PHONE: '10' }));
  assert.ok(r.ok, JSON.stringify(r));
  const text = fs.readFileSync(file, 'utf8');
  for (const keep of ['# my notes about the party', 'PORT=8484', 'PUBLIC_URL="http://$(echo 10.1.2.3):8484/"     # worked out when it is read',
    "JUKEBOX_TITLE='Woody''s Bar'", '  export JUKEBOX_MAX_QUEUE=40', 'MY_OWN_THING=1']) {
    assert.ok(text.includes(keep + '\n'), `kept as written: ${keep}\n---\n${text}`);
  }
  assert.ok(text.includes(`${conf.MARKER}\nJUKEBOX_MAX_PER_PHONE='10'\n`), 'the new one added under the marker');

  // Change the queue: rewritten in its own place, no longer export-ed but still set.
  r = conf.writeConf(file, Object.assign({}, conf.readConf(file).values, { JUKEBOX_MAX_QUEUE: '30' }));
  assert.ok(r.ok);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  assert.equal(lines[5], "JUKEBOX_MAX_QUEUE='30'", 'in place, where it was');
  assert.equal(asTheServerSeesIt(file).JUKEBOX_MAX_QUEUE, '30');

  // Nothing changed: the file is not touched at all.
  const before = fs.readFileSync(file, 'utf8');
  r = conf.writeConf(file, conf.readConf(file).values);
  assert.ok(r.ok && r.unchanged);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// 4 ------------------------------------------------------------------------
test('back to a default removes the line; duplicates collapse to the one the shell used', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  fs.writeFileSync(file, "JUKEBOX_TITLE='One'\nJUKEBOX_TITLE='Two'\nJUKEBOX_REPEAT_MINUTES=60\n");
  assert.equal(conf.readConf(file).values.JUKEBOX_TITLE, 'Two', 'the shell takes the last');

  let r = conf.writeConf(file, { JUKEBOX_TITLE: 'Three' });
  assert.ok(r.ok);
  let text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/JUKEBOX_TITLE=/g) || []).length, 1, 'one line, not two:\n' + text);
  assert.equal(conf.readConf(file).values.JUKEBOX_TITLE, 'Three');

  r = conf.writeConf(file, { JUKEBOX_TITLE: 'JUKEBOX' });
  assert.ok(r.ok);
  text = fs.readFileSync(file, 'utf8');
  assert.ok(!/JUKEBOX_TITLE=/.test(text), 'the default is not written down');

  // 0 is a real value for the repeat window, not "unset".
  r = conf.writeConf(file, { JUKEBOX_REPEAT_MINUTES: '0' });
  assert.ok(r.ok);
  assert.equal(conf.readConf(file).values.JUKEBOX_REPEAT_MINUTES, '0');
  assert.equal(asTheServerSeesIt(file).JUKEBOX_REPEAT_MINUTES, '0');

  // An empty title or playlist means the default, never an empty marquee.
  r = conf.writeConf(file, { JUKEBOX_TITLE: '   ', JUKEBOX_PLAYLIST: '' });
  assert.ok(r.ok);
  assert.equal(conf.readConf(file).values.JUKEBOX_TITLE, 'JUKEBOX');
  assert.equal(conf.readConf(file).values.JUKEBOX_PLAYLIST, 'Jukebox');
});

// 5 ------------------------------------------------------------------------
test('values that would not work are refused, in words, and nothing is written', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  fs.writeFileSync(file, "JUKEBOX_TITLE='Mine'\n");
  const bad = {
    JUKEBOX_MAX_PER_PHONE: 'ten',
    JUKEBOX_MAX_QUEUE: '0',
    JUKEBOX_REPEAT_MINUTES: '-5',
    JUKEBOX_PLAYLIST: 'Library',
    PUBLIC_URL: '192.168.1.40',
    JUKEBOX_WIFI_PASSWORD: 'short',
    JUKEBOX_TITLE: 'x'.repeat(41),
  };
  const r = conf.writeConf(file, bad);
  assert.equal(r.ok, false);
  for (const k of Object.keys(bad)) assert.ok(r.errors[k], `${k} refused`);
  assert.ok(/needed/i.test(r.errors.JUKEBOX_WIFI_NAME), 'a password without a network name');
  assert.equal(fs.readFileSync(file, 'utf8'), "JUKEBOX_TITLE='Mine'\n", 'the file is untouched');
  assert.ok(conf.writeConf(file, { JUKEBOX_TITLE: 'two\nlines' }).errors.JUKEBOX_TITLE);
  assert.ok(conf.writeConf(file, { JUKEBOX_WIFI_NAME: 'x'.repeat(33) }).errors.JUKEBOX_WIFI_NAME);
  assert.ok(conf.writeConf(file, { PUBLIC_URL: 'http://192.168.1.40:8484/' }).ok, 'a proper URL is fine');
});

// 6 ------------------------------------------------------------------------
test('a broken file is reported, not overwritten', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  const broken = "JUKEBOX_TITLE='unclosed\n";
  fs.writeFileSync(file, broken);
  const r = conf.readConf(file);
  assert.equal(r.ok, false);
  assert.ok(/mistake/.test(r.error), r.error);
  const w = conf.writeConf(file, { JUKEBOX_TITLE: 'Fixed?' });
  assert.equal(w.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'left exactly as it was, for a human to see');
});

// 7 ------------------------------------------------------------------------
test('a save the shell would read differently is undone', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  // A later line the writer cannot see as an assignment overrides the title.
  const tricky = "JUKEBOX_TITLE='A'\neval 'JUKEBOX_TITLE=Sneaky'\n";
  fs.writeFileSync(file, tricky);
  assert.equal(conf.readConf(file).values.JUKEBOX_TITLE, 'Sneaky');
  const r = conf.writeConf(file, { JUKEBOX_TITLE: 'Wanted' });
  assert.equal(r.ok, false);
  assert.ok(/JUKEBOX_TITLE/.test(r.error) && /kept/.test(r.error), r.error);
  assert.equal(fs.readFileSync(file, 'utf8'), tricky, 'the old file is back');
});

// 8 ------------------------------------------------------------------------
test('a first save starts from the example, comments and all', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'jukebox.conf');
  const example = path.join(ROOT, 'jukebox.conf.example');
  let r = conf.readConf(file);
  assert.ok(r.ok && !r.exists);
  assert.deepEqual(r.values, conf.DEFAULTS, 'no file is all defaults');
  r = conf.writeConf(file, { JUKEBOX_WIFI_NAME: 'Home', JUKEBOX_WIFI_PASSWORD: 'hunter2hunter2' }, { example });
  assert.ok(r.ok, JSON.stringify(r));
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith(fs.readFileSync(example, 'utf8').split('\n')[0]), 'the example\'s own explanations come first');
  assert.ok(text.includes("JUKEBOX_WIFI_NAME='Home'"));
  assert.equal(conf.readConf(file).values.JUKEBOX_WIFI_PASSWORD, 'hunter2hunter2');
});

// 9 ------------------------------------------------------------------------
test('the command line the app uses: read, write from stdin, errors as JSON', () => {
  const dir = tmp();
  const file = path.join(dir, 'jukebox.conf');
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { input: input || '', encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.equal(run(['read', file]).values.JUKEBOX_TITLE, 'JUKEBOX');
  assert.ok(run(['write', file], JSON.stringify({ JUKEBOX_TITLE: 'Party' })).ok);
  assert.equal(run(['read', file]).values.JUKEBOX_TITLE, 'Party');
  const bad = run(['write', file], JSON.stringify({ JUKEBOX_MAX_QUEUE: 'lots' }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.JUKEBOX_MAX_QUEUE);
  assert.equal(run(['write', file], 'not json').ok, false);
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  console.log('\nSETTINGS FILE SUITE\n' + '='.repeat(72));
  for (const t of tests) {
    if (process.env.ONLY && !t.name.includes(process.env.ONLY)) continue;
    try { await t.fn(); console.log(`PASS  ${t.name}`); pass++; }
    catch (e) { console.log(`FAIL  ${t.name}\n      ${e.message}`); fail++; }
  }
  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
