'use strict';

// The guest network: which address the QR code puts guests on.
//   node test/network-suite.js        (VERBOSE=1 for server output, ONLY=<text>)
//
// The Mac app's Guest Network menu and Settings tab both drive this through
// one host-only route, POST /api/host/network, and the server is the
// authority on what guests are given. These were the server half of the old
// menu bar suite; they outlived it.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const net = require('../lib/net');

const ROOT = path.resolve(__dirname, '..');
const VERBOSE = process.env.VERBOSE === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend Mac mini: Ethernet on en0, Wi-Fi on en1, Wi-Fi is the default route.
const FAKE_NET = {
  interfaces: {
    lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    en0: [{ family: 'IPv4', internal: false, address: '10.77.0.5' }],
    en1: [{ family: 'IPv4', internal: false, address: '192.168.1.40' }],
  },
  primary: 'en1',
};

async function waitFor(fn, { timeout = 10000, interval = 25, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout}ms waiting for: ${label}`);
    await sleep(interval);
  }
}

function call(method, url, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(url, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(c)); } catch (e) {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve(null));
    req.end(data || undefined);
  });
}

function sseListen(url) {
  const events = [];
  let buf = '';
  const req = http.get(url, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const data = /^data: (.+)$/m.exec(block);
        if (ev && data) { try { events.push({ event: ev[1], data: JSON.parse(data[1]) }); } catch (e) {} }
      }
    });
  });
  req.on('error', () => {});
  return { events, close: () => req.destroy() };
}

function startServer({ port, publicUrl }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-net-'));
  const env = Object.assign({}, process.env, {
    MOCK: '1', PORT: String(port), JUKEBOX_DATA_DIR: dataDir, MOCK_LIBRARY: '150',
    JUKEBOX_TEST_NETWORK: JSON.stringify(FAKE_NET),
  });
  if (publicUrl) env.PUBLIC_URL = publicUrl; else delete env.PUBLIC_URL;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: VERBOSE ? 'inherit' : 'ignore' });
  return {
    dataDir,
    base: `http://127.0.0.1:${port}`,
    ready: () => waitFor(async () => { const r = await call('GET', `http://127.0.0.1:${port}/api/config`); return r && r.status === 200; },
      { label: 'the mock server to come up', timeout: 20000 }),
    stop: () => { try { child.kill('SIGKILL'); } catch (e) {} try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 1 ------------------------------------------------------------------------
test('guest address: menu choice, then jukebox.conf, then the routing table', () => {
  const candidates = net.lanCandidates(FAKE_NET.interfaces);
  const r = (x) => net.resolveGuestUrl(Object.assign({ port: 8484, candidates, primary: 'en1' }, x));

  assert.deepEqual([r({}).url, r({}).source, r({}).iface], ['http://192.168.1.40:8484/', 'auto', 'en1'],
    'nothing chosen follows the default route');
  assert.equal(r({ publicUrl: 'http://jb.local:8484/' }).url, 'http://jb.local:8484/', 'jukebox.conf beats the route');
  assert.equal(r({ publicUrl: 'http://jb.local:8484/' }).source, 'conf');
  assert.equal(r({ choice: 'en0', publicUrl: 'http://jb.local:8484/' }).url, 'http://10.77.0.5:8484/', 'the menu choice beats jukebox.conf');
  assert.equal(r({ choice: 'en0' }).source, 'chosen');

  // Cable out: never put a dead address on the QR code.
  const gone = r({ choice: 'en5' });
  assert.equal(gone.url, 'http://192.168.1.40:8484/', 'an adapter with no address falls back');
  assert.equal(gone.chosenMissing, true, 'and says so');
  assert.equal(r({ choice: 'en5', publicUrl: 'http://jb.local:8484/' }).url, 'http://jb.local:8484/');
  assert.equal(r({ choice: 'en0' }).chosenMissing, false);

  const none = net.resolveGuestUrl({ port: 8484, candidates: [], primary: null });
  assert.equal(none.url, null);
  assert.equal(none.source, 'none');
});

// 2 ------------------------------------------------------------------------
test('the adapter choice survives on disk and junk in the file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-choice-'));
  try {
    const f = path.join(dir, 'sub', 'network.json');
    assert.equal(net.readNetworkChoice(f), null, 'no file is automatic');
    assert.equal(net.writeNetworkChoice(f, 'en1'), 'en1');
    assert.equal(net.readNetworkChoice(f), 'en1');
    assert.ok(!fs.existsSync(f + '.tmp'), 'written by rename, no temp left behind');
    net.writeNetworkChoice(f, 'auto');
    assert.ok(!fs.existsSync(f), '"auto" removes the file');
    net.writeNetworkChoice(f, null);                  // already gone: fine
    for (const bad of ['en0; rm -rf ~', '../../etc', 'x'.repeat(16), 42]) {
      assert.throws(() => net.writeNetworkChoice(f, bad), /not an interface/, `refuses ${JSON.stringify(bad)}`);
    }
    fs.writeFileSync(f, '{"interface":"en0; reboot"}');
    assert.equal(net.readNetworkChoice(f), null, 'a hand-edited bad value reads as automatic');
    fs.writeFileSync(f, 'not json');
    assert.equal(net.readNetworkChoice(f), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 3 ------------------------------------------------------------------------
test('choosing an adapter repoints guests at once, and redraws the laptop\'s QR code live', async () => {
  const conf = 'http://jukebox.local:8611/';
  const srv = startServer({ port: 8611, publicUrl: conf });
  let sse = null;
  try {
    await srv.ready();
    let r = await call('GET', srv.base + '/api/host/network');
    assert.equal(r.status, 200);
    assert.equal(r.json.guestUrl, conf, 'automatic with PUBLIC_URL set is PUBLIC_URL');
    assert.equal(r.json.source, 'conf');
    assert.deepEqual(r.json.adapters.map((a) => a.name).sort(), ['en0', 'en1'], 'the adapters, for the app to list');

    sse = sseListen(srv.base + '/api/events');
    await waitFor(() => sse.events.some((e) => e.event === 'state'), { label: 'SSE connected' });

    r = await call('POST', srv.base + '/api/host/network', { interface: 'en0' });
    assert.equal(r.status, 200);
    assert.equal(r.json.guestUrl, 'http://10.77.0.5:8611/');
    await waitFor(() => sse.events.some((e) => e.event === 'config'), { label: 'a config event', timeout: 3000 });
    assert.deepEqual(sse.events.find((e) => e.event === 'config').data, { guestUrl: 'http://10.77.0.5:8611/' },
      'the laptop is told the new address without reloading');
    assert.equal((await call('GET', srv.base + '/api/config')).json.guestUrl, 'http://10.77.0.5:8611/', 'a page loaded now gets it too');
    assert.equal(net.readNetworkChoice(path.join(srv.dataDir, 'network.json')), 'en0', 'and it is kept for next time');

    // Chosen, then unplugged: the server falls back and says why.
    r = await call('POST', srv.base + '/api/host/network', { interface: 'en5' });
    assert.equal(r.json.guestUrl, conf);
    assert.equal(r.json.chosenMissing, true);
    assert.equal(r.json.choice, 'en5');

    r = await call('POST', srv.base + '/api/host/network', { interface: null });
    assert.equal(r.json.guestUrl, conf, 'null is automatic');
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'network.json')));

    const bad = await call('POST', srv.base + '/api/host/network', { interface: '../etc' });
    assert.equal(bad.status, 400, 'the server refuses a non-interface');
  } finally {
    if (sse) sse.close();
    srv.stop();
  }
});

// 4 ------------------------------------------------------------------------
test('the network route is laptop-only, like every host route', async () => {
  const remoteIp = (() => {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
    }
    return null;
  })();
  if (!remoteIp) { console.log('    (no non-loopback address on this box -- not exercised)'); return; }
  const srv = startServer({ port: 8612 });
  try {
    await srv.ready();
    const r = await call('POST', `http://${remoteIp}:8612/api/host/network`, { interface: 'en0' });
    assert.equal(r.status, 403, 'a phone cannot repoint the QR code');
    assert.ok(!fs.existsSync(path.join(srv.dataDir, 'network.json')));
    assert.equal((await call('GET', `http://${remoteIp}:8612/api/host/network`)).status, 403, 'or even read it');
  } finally { srv.stop(); }
});

// ---------------------------------------------------------------------------
(async () => {
  let pass = 0, fail = 0;
  console.log('\nGUEST NETWORK SUITE\n' + '='.repeat(72));
  for (const t of tests) {
    if (process.env.ONLY && !t.name.includes(process.env.ONLY)) continue;
    const started = Date.now();
    try { await t.fn(); console.log(`PASS  ${t.name}  (${Date.now() - started}ms)`); pass++; }
    catch (e) { console.log(`FAIL  ${t.name}\n      ${e.message}`); fail++; }
  }
  console.log('='.repeat(72));
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
