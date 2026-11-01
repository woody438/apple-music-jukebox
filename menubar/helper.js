#!/usr/bin/env node
'use strict';

// The menu bar's brain.
//
// menubar.js is JXA, which runs only on a Mac and cannot be tested anywhere
// else. So it is kept deliberately dumb: it asks this script what the menu
// should say (`menu`), draws exactly that, and hands every click back here
// (`do <action> [arg]`). Every decision -- what is enabled, which adapter is
// ticked, whether an update is waiting -- lives in this file, in plain Node,
// and test/menubar-suite.js exercises it without a Mac.
//
//   node menubar/helper.js menu                    -> JSON for the menu
//   node menubar/helper.js do start|stop|open-page|install-update
//   node menubar/helper.js do network <en1|auto>
//   node menubar/helper.js do check-updates        (slow: the menu backgrounds it)
//
// Options: --port 8484  --public-url URL  --data-dir DIR  --repo DIR
//
// Zero dependencies, like everything else here.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const net = require('../lib/net');

const REPO_DEFAULT = path.resolve(__dirname, '..');
const CHECK_STALE_MS = 2 * 60 * 1000;    // a "checking" record older than this died
const FETCH_TIMEOUT_MS = 45 * 1000;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      opts[a.slice(2)] = argv[i + 1] === undefined ? '' : argv[i + 1];
      i++;
    } else {
      opts._.push(a);
    }
  }
  const repo = path.resolve(opts.repo || REPO_DEFAULT);
  return {
    args: opts._,
    repo,
    port: Number(opts.port) || Number(process.env.PORT) || 8484,
    publicUrl: opts['public-url'] || process.env.PUBLIC_URL || null,
    dataDir: path.resolve(opts['data-dir'] || process.env.JUKEBOX_DATA_DIR || path.join(repo, 'data')),
    // Tests set this so `do start` prints what it would run instead of running it.
    dryRun: process.env.JUKEBOX_HELPER_DRYRUN === '1',
  };
}

const files = (o) => ({
  network: path.join(o.dataDir, 'network.json'),
  update: path.join(o.dataDir, 'update-check.json'),
  starting: path.join(o.dataDir, 'launcher-starting.pid'),
  log: path.join(o.dataDir, 'menubar.log'),
});

// ---------------------------------------------------------------------------
// small things
// ---------------------------------------------------------------------------
function request(method, url, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      timeout: timeoutMs,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj) + '\n');
  fs.renameSync(tmp, file);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const hostPort = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

function log(o, msg) {
  try {
    fs.mkdirSync(o.dataDir, { recursive: true });
    fs.appendFileSync(files(o).log, `[${new Date().toTimeString().slice(0, 8)}] helper: ${msg}\n`);
  } catch (e) { /* a log is never worth failing over */ }
}

// Same mechanism the Dock app already uses. The message goes in as an
// argument, never spliced into the script, so no title can break the quoting.
function notify(o, message) {
  if (o.dryRun) { console.log('NOTIFY ' + message); return; }
  if (process.platform !== 'darwin') return;
  try {
    spawn('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'display notification (item 1 of argv) with title "Party Jukebox"',
      '-e', 'end run',
      message,
    ], { stdio: 'ignore', detached: true }).unref();
  } catch (e) { /* the menu still shows the result */ }
}

// Launch something and walk away. The menu never waits on it.
function launch(o, cmd, args) {
  log(o, `run ${cmd} ${args.join(' ')}`);
  if (o.dryRun) { console.log('RUN ' + [cmd].concat(args).join(' ')); return; }
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

// ---------------------------------------------------------------------------
// what is true right now
// ---------------------------------------------------------------------------

// Asks the server, which is the only authority on what guests are actually
// given: it read jukebox.conf when it started, and this script may not have.
async function serverState(o) {
  const base = `http://127.0.0.1:${o.port}`;
  const nw = await request('GET', base + '/api/host/network', undefined, 1500);
  if (nw && nw.status === 200 && nw.json && nw.json.ok) return { running: true, network: nw.json };
  // Up, but a version without the network route (or answering 404/403):
  // still running, just less to say.
  const cfg = nw ? await request('GET', base + '/api/config', undefined, 1500) : null;
  if (cfg && cfg.status === 200 && cfg.json) return { running: true, network: null, guestUrl: cfg.json.guestUrl || null };
  return { running: false, network: null };
}

// The Dock app writes its pid here for as long as it is bringing the server
// up -- indexing a big library takes a moment and "stopped" would be a lie.
function launcherStarting(o) {
  try {
    const pid = Number(String(fs.readFileSync(files(o).starting, 'utf8')).trim());
    return alive(pid);
  } catch (e) { return false; }
}

function networkView(o, server) {
  const candidates = net.lanCandidates(net.networkInterfaces());
  const primary = net.primaryInterfaceName();
  const ports = net.hardwarePorts();
  const choice = net.readNetworkChoice(files(o).network);
  const local = net.resolveGuestUrl({ choice, publicUrl: o.publicUrl, port: o.port, candidates, primary });
  // What "Automatic" would give, whatever is chosen now.
  const auto = net.resolveGuestUrl({ choice: null, publicUrl: o.publicUrl, port: o.port, candidates, primary });

  const live = server && server.network;
  return {
    choice,
    adapters: candidates.map((c) => ({ name: c.name, ip: c.ip, label: ports[c.name] || null, primary: c.name === primary })),
    labels: ports,
    // Trust the running server over our own sums when it can tell us.
    guestUrl: live ? live.guestUrl : server && server.running && server.guestUrl !== undefined ? server.guestUrl : local.url,
    source: live ? live.source : local.source,
    iface: live ? live.iface : local.iface,
    chosenMissing: live ? !!live.chosenMissing : local.chosenMissing,
    autoSource: auto.source,
    autoIface: auto.iface,
    autoUrl: auto.url,
  };
}

// ---------------------------------------------------------------------------
// updates: check only. Installing is Update.command's job, run where you can
// watch it, and it refuses while the jukebox is up.
// ---------------------------------------------------------------------------
function findGit() {
  for (const c of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) { /* next */ }
  }
  return 'git';
}

function git(o, args, extra) {
  return execFileSync(findGit(), args, Object.assign({
    cwd: o.repo,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never sit waiting for a password nobody is there to type.
    env: Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
    }),
  }, extra || {})).trim();
}

function headSha(o) {
  try { return git(o, ['rev-parse', 'HEAD']); } catch (e) { return null; }
}

function checkUpdates(o) {
  const f = files(o).update;
  const prior = readJson(f);
  if (prior && prior.state === 'checking' && alive(prior.pid) && Date.now() - prior.startedAt < CHECK_STALE_MS) {
    return prior;    // one is already running; the menu shows it
  }
  writeJson(f, { state: 'checking', pid: process.pid, startedAt: Date.now() });

  let result;
  try {
    let upstream;
    try {
      upstream = git(o, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch (e) {
      throw Object.assign(new Error('This copy is not following a branch on GitHub.'), { friendly: true });
    }
    try {
      git(o, ['fetch', '--quiet'], { timeout: FETCH_TIMEOUT_MS });
    } catch (e) {
      throw Object.assign(new Error('Could not reach GitHub. Check the internet.'), { friendly: true });
    }
    const local = git(o, ['rev-parse', 'HEAD']);
    const remote = git(o, ['rev-parse', '@{u}']);
    const behind = Number(git(o, ['rev-list', '--count', 'HEAD..@{u}'])) || 0;
    const ahead = Number(git(o, ['rev-list', '--count', '@{u}..HEAD'])) || 0;
    const subjects = behind ? git(o, ['log', '--format=%s', '-n', '5', 'HEAD..@{u}']).split('\n').filter(Boolean) : [];
    // Same test Update.command applies before it will pull.
    const dirty = git(o, ['status', '--porcelain']) !== '';
    result = {
      state: behind ? 'available' : 'current',
      behind, ahead, dirty, subjects, upstream,
      local, remote, checkedAt: Date.now(),
    };
  } catch (e) {
    result = {
      state: 'error',
      message: e.friendly ? e.message : 'Could not check: ' + String(e.message || e).split('\n')[0].slice(0, 120),
      local: headSha(o),
      checkedAt: Date.now(),
    };
  }
  writeJson(f, result);
  log(o, `update check: ${result.state}${result.behind ? ' (' + result.behind + ' behind)' : ''}${result.message ? ' -- ' + result.message : ''}`);
  return result;
}

// The stored result, made honest: a check whose process died is not still
// checking, and a result recorded against an older checkout is stale the
// moment Update.command moves HEAD.
function updateView(o) {
  const r = readJson(files(o).update);
  if (!r || typeof r !== 'object') return { state: 'idle' };
  if (r.state === 'checking') {
    if (alive(r.pid) && Date.now() - r.startedAt < CHECK_STALE_MS) return { state: 'checking' };
    return { state: 'error', message: 'The last check did not finish.' };
  }
  if (r.local && r.local !== headSha(o)) return { state: 'idle' };
  return r;
}

// ---------------------------------------------------------------------------
// the menu, as data. Pure: everything it needs is in `v`.
// ---------------------------------------------------------------------------
function adapterTitle(a) {
  return `${a.label ? `${a.label} (${a.name})` : a.name} — ${a.ip}`;
}

function buildMenu(v) {
  const state = v.running ? 'running' : v.starting ? 'starting' : 'stopped';
  const n = v.network;
  const u = v.update || { state: 'idle' };
  const items = [];
  const add = (title, extra) => items.push(Object.assign({ title, enabled: false }, extra || {}));
  const sep = () => items.push({ separator: true });
  const labelOf = (name) => (n.labels && n.labels[name]) || name;

  add(state === 'running' ? 'Jukebox is running' : state === 'starting' ? 'Jukebox is starting…' : 'Jukebox is stopped');
  let guest = n.guestUrl ? 'Guests: ' + hostPort(n.guestUrl) : 'Guests: no network address';
  if (n.chosenMissing && n.choice) guest += ` (${labelOf(n.choice)} not connected)`;
  add(guest);
  sep();

  add('Open Jukebox Page', { enabled: state === 'running', action: 'open-page' });
  sep();
  add('Start Jukebox', { enabled: state === 'stopped', action: 'start' });
  add('Stop Jukebox', { enabled: state === 'running', action: 'stop' });
  sep();

  // --- which network the QR code points at ---
  add('Guest Network');
  const autoWhat = n.autoSource === 'conf' ? 'jukebox.conf'
    : n.autoSource === 'auto' ? labelOf(n.autoIface)
    : 'no address';
  add(`Automatic — ${autoWhat}`, { enabled: true, checked: !n.choice, indent: 1, action: 'network', arg: 'auto' });
  for (const a of n.adapters) {
    add(adapterTitle(a), { enabled: true, checked: n.choice === a.name, indent: 1, action: 'network', arg: a.name });
  }
  if (n.choice && !n.adapters.some((a) => a.name === n.choice)) {
    add(`${n.labels && n.labels[n.choice] ? `${n.labels[n.choice]} (${n.choice})` : n.choice} — not connected`,
      { checked: true, indent: 1 });
  }
  if (!n.adapters.length) add('No network address found', { indent: 1 });
  sep();

  // --- updates ---
  if (u.state === 'checking') {
    add('Checking for Updates…');
  } else if (u.state === 'available') {
    const what = `${u.behind} change${u.behind === 1 ? '' : 's'}`;
    if (state !== 'stopped') add(`Update ready (${what}) — stop the jukebox to install`);
    else add(`Install Update (${what})…`, { enabled: true, action: 'install-update' });
    if (u.dirty) add('This copy has local edits — the update will refuse', { indent: 1 });
    else if (u.ahead) add('This copy has its own commits — the update cannot apply', { indent: 1 });
    add('Check Again', { enabled: true, action: 'check-updates' });
  } else {
    add('Check for Updates…', { enabled: true, action: 'check-updates' });
    if (u.state === 'current') add('Up to date' + (u.checkedAt ? ' · checked ' + clock(u.checkedAt) : ''), { indent: 1 });
    if (u.state === 'error') add(u.message || 'Could not check.', { indent: 1 });
  }
  sep();
  add('Quit Menu Bar Icon', { enabled: true, action: 'quit' });

  const tooltip = 'Party Jukebox — ' + state + (n.guestUrl ? ' · guests ' + hostPort(n.guestUrl) : '');
  return { state, tooltip, items };
}

function clock(ms) {
  return new Date(ms).toTimeString().slice(0, 5);
}

async function gatherView(o) {
  const server = await serverState(o);
  return {
    running: server.running,
    starting: !server.running && launcherStarting(o),
    network: networkView(o, server),
    update: updateView(o),
  };
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function setNetwork(o, iface) {
  const want = !iface || iface === 'auto' ? null : iface;
  if (want !== null && !net.isInterfaceName(want)) throw new Error('not an interface name');
  // Through the server when it is up: it writes the same file, and it also
  // redraws the QR code on the laptop there and then.
  const r = await request('POST', `http://127.0.0.1:${o.port}/api/host/network`, { interface: want }, 2000);
  let guestUrl;
  if (r && r.status === 200 && r.json && r.json.ok) {
    guestUrl = r.json.guestUrl;
  } else {
    net.writeNetworkChoice(files(o).network, want);
    guestUrl = networkView(o, null).guestUrl;
  }
  log(o, `network -> ${want || 'automatic'}: ${guestUrl || 'no address'}`);
  notify(o, guestUrl ? `Guests now get ${hostPort(guestUrl)}` : 'No network address for guests on that adapter.');
  return { ok: true, guestUrl };
}

async function doAction(o, action, arg) {
  const app = path.join(o.repo, 'Jukebox.app');
  switch (action) {
    // Start and stop go through Jukebox.app, launched by LaunchServices
    // exactly as a Dock click launches it. That keeps the server's parent --
    // and so the app macOS asks "may this control Music?" about -- the same
    // one that has always been approved. Spawning node from here would make
    // the menu bar the parent, and the first pick of the night would raise
    // a brand-new permission prompt on the laptop screen.
    case 'start': return launch(o, '/usr/bin/open', ['-n', '-g', app, '--args', 'start']);
    case 'stop': return launch(o, '/usr/bin/open', ['-n', '-g', app, '--args', 'stop']);
    // localhost, never the LAN address: only localhost gets host rights.
    case 'open-page': return launch(o, '/usr/bin/open', [`http://localhost:${o.port}/`]);
    case 'install-update': {
      // Update.command refuses while the jukebox runs; checking here too saves
      // opening a Terminal window just to be told no.
      if ((await serverState(o)).running) {
        notify(o, 'Stop the jukebox first, then install the update.');
        return;
      }
      return launch(o, '/usr/bin/open', [path.join(o.repo, 'Update.command')]);
    }
    case 'check-updates': {
      const r = checkUpdates(o);
      if (r.state === 'available') {
        notify(o, `Update available: ${r.behind} change${r.behind === 1 ? '' : 's'}. ` +
          ((await serverState(o)).running ? 'Stop the jukebox, then Install Update from the menu.' : 'Choose Install Update from the menu.'));
      } else if (r.state === 'current') {
        notify(o, 'The jukebox is up to date.');
      } else if (r.state === 'error') {
        notify(o, r.message);
      }
      return r;
    }
    case 'network': return setNetwork(o, arg);
    default: throw new Error(`unknown action: ${action}`);
  }
}

// Pure ASCII on stdout: titles carry — and …, and the menu bar reads this
// through do shell script, whose decoding of anything else is one more thing
// that could differ between macOS versions. \u escapes are plain JSON.
function asciiJson(x, indent) {
  return JSON.stringify(x, null, indent).replace(/[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---------------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const [cmd, action, arg] = o.args;
  if (cmd === 'menu') {
    process.stdout.write(asciiJson(buildMenu(await gatherView(o))) + '\n');
    return;
  }
  if (cmd === 'view') {          // the raw facts, for debugging on the Mac
    process.stdout.write(asciiJson(await gatherView(o), 2) + '\n');
    return;
  }
  if (cmd === 'do') {
    const r = await doAction(o, action, arg);
    if (r !== undefined) process.stdout.write(asciiJson(r) + '\n');
    return;
  }
  process.stderr.write('usage: helper.js menu | view | do <action> [arg]\n');
  process.exit(2);
}

if (require.main === module) {
  main().catch((e) => {
    try { log(parseArgs(process.argv.slice(2)), 'FAILED ' + (e && e.stack || e)); } catch (_) {}
    process.stderr.write(String(e && e.message || e) + '\n');
    process.exit(1);
  });
}

module.exports = {
  parseArgs, buildMenu, gatherView, networkView, updateView, checkUpdates, doAction, setNetwork,
  serverState, hostPort, adapterTitle,
};
