'use strict';

// Working out which address to put on the QR code.
//
// This used to guess from the interface name and prefer en0, on the belief
// that en0 is the Wi-Fi. That is true on a laptop and false on a Mac mini,
// where en0 is usually Ethernet -- so a machine with two adapters handed
// guests the address of the wrong network and nobody could reach it.
//
// The routing table knows the answer, so ask it instead of guessing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Tests only. The suites run on Linux boxes whose one address is not private,
// so they hand in a pretend Mac instead:
//   JUKEBOX_TEST_NETWORK='{"interfaces":{...},"primary":"en1","ports":{"en1":"Wi-Fi"}}'
// Nothing on a real machine sets this.
function testNetwork() {
  const raw = process.env.JUKEBOX_TEST_NETWORK;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function isPrivateIPv4(ip) {
  return /^192\.168\./.test(ip) ||
         /^10\./.test(ip) ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}

// Every private IPv4 this machine has, with the interface it belongs to.
function lanCandidates(ifaces) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces || {})) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (!isPrivateIPv4(a.address)) continue;
      out.push({ name, ip: a.address });
    }
  }
  return out;
}

// The interface this Mac actually sends traffic out of.
function primaryInterfaceName() {
  const t = testNetwork();
  if (t) return t.primary || null;
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('route', ['-n', 'get', 'default'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/interface:\s*(\S+)/);
    return m ? m[1] : null;
  } catch (e) {
    return null;   // not macOS, no default route, or route refused to answer
  }
}

// Pure, so the two-adapter case is testable without two adapters.
function pickLanAddress(candidates, primaryName) {
  if (!candidates.length) return null;
  if (primaryName) {
    const onPrimary = candidates.find((c) => c.name === primaryName);
    if (onPrimary) return onPrimary.ip;
  }
  return candidates[0].ip;
}

function networkInterfaces() {
  const t = testNetwork();
  return t ? (t.interfaces || {}) : os.networkInterfaces();
}

function lanAddress() {
  return pickLanAddress(lanCandidates(networkInterfaces()), primaryInterfaceName());
}

// ---------------------------------------------------------------------------
// Choosing the adapter by hand, from the menu bar.
//
// The routing table is right most of the time, and PUBLIC_URL in jukebox.conf
// covers the rest -- but only for someone who can edit a shell file, and it
// pins an IP address that DHCP may hand to someone else next week. The menu
// bar pins an INTERFACE instead ("use the Wi-Fi"), and the address is looked
// up fresh every time a page asks for it.
//
// Stored in data/network.json: per machine, ignored by git, so it neither
// travels to another Mac nor blocks Update.command.
// ---------------------------------------------------------------------------

// en0, en1, bridge0, utun3. Anything else is not an interface name, and it is
// never passed to a shell anyway -- this keeps junk out of the file.
function isInterfaceName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{1,15}$/.test(s);
}

function readNetworkChoice(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && isInterfaceName(j.interface) ? j.interface : null;
  } catch (e) {
    return null;   // no file is the normal case: automatic
  }
}

// null clears the choice, back to automatic. Write-then-rename, like state.json.
function writeNetworkChoice(file, iface) {
  if (iface === null || iface === undefined || iface === '' || iface === 'auto') {
    try { fs.unlinkSync(file); } catch (e) { /* already automatic */ }
    return null;
  }
  if (!isInterfaceName(iface)) throw new Error(`not an interface name: ${String(iface).slice(0, 40)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ interface: iface, chosenAt: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, file);
  return iface;
}

// Pure. The order matters and is the whole design:
//   1. an adapter chosen in the menu bar, if it has an address right now
//   2. PUBLIC_URL from jukebox.conf
//   3. the routing table
// A chosen adapter that has lost its address (cable out, Wi-Fi off) falls
// through rather than putting a dead address on the QR code, and says so in
// chosenMissing so the menu can tell the host.
function resolveGuestUrl({ choice, publicUrl, port, candidates, primary }) {
  const cands = candidates || [];
  let chosenMissing = false;
  if (choice) {
    const c = cands.find((x) => x.name === choice);
    if (c) return { url: `http://${c.ip}:${port}/`, source: 'chosen', iface: c.name, ip: c.ip, chosenMissing };
    chosenMissing = true;
  }
  if (publicUrl) return { url: publicUrl, source: 'conf', iface: null, ip: null, chosenMissing };
  const ip = pickLanAddress(cands, primary);
  if (!ip) return { url: null, source: 'none', iface: null, ip: null, chosenMissing };
  const c = cands.find((x) => x.ip === ip);
  return { url: `http://${ip}:${port}/`, source: 'auto', iface: c ? c.name : null, ip, chosenMissing };
}

// `networksetup -listallhardwareports` -> { en0: 'Ethernet', en1: 'Wi-Fi' }.
// Only for labels: "Wi-Fi (en1)" means something to a host, "en1" does not.
// Pure, so it is tested against real output without a Mac.
function parseHardwarePorts(text) {
  const out = {};
  let port = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = /^Hardware Port:\s*(.+?)\s*$/.exec(line);
    if (m) { port = m[1]; continue; }
    m = /^Device:\s*(\S+)/.exec(line);
    if (m && port) { out[m[1]] = port; port = null; }
  }
  return out;
}

function hardwarePorts() {
  const t = testNetwork();
  if (t) return t.ports || {};
  if (process.platform !== 'darwin') return {};
  try {
    return parseHardwarePorts(execFileSync('/usr/sbin/networksetup', ['-listallhardwareports'], {
      encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (e) {
    return {};     // labels are a nicety; the device names still work
  }
}

// The text a phone camera reads as "join this Wi-Fi": the WIFI: format from
// ZXing, which the iPhone and Android cameras both act on. \ ; , : " are the
// format's delimiters and must be backslash-escaped -- a password with a ; in
// it would otherwise end early and the phone would join with the wrong one.
// Values are left unquoted. No password means an open network.
function wifiQrText(name, password) {
  if (!name) return null;
  const esc = (s) => String(s).replace(/[\\;,:"]/g, '\\$&');
  return password
    ? `WIFI:T:WPA;S:${esc(name)};P:${esc(password)};;`
    : `WIFI:T:nopass;S:${esc(name)};;`;
}

module.exports = {
  isPrivateIPv4, lanCandidates, primaryInterfaceName, pickLanAddress, lanAddress, networkInterfaces,
  isInterfaceName, readNetworkChoice, writeNetworkChoice, resolveGuestUrl, parseHardwarePorts, hardwarePorts,
  wifiQrText,
};
