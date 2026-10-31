'use strict';

// Working out which address to put on the QR code.
//
// This used to guess from the interface name and prefer en0, on the belief
// that en0 is the Wi-Fi. That is true on a laptop and false on a Mac mini,
// where en0 is usually Ethernet -- so a machine with two adapters handed
// guests the address of the wrong network and nobody could reach it.
//
// The routing table knows the answer, so ask it instead of guessing.

const os = require('os');
const { execFileSync } = require('child_process');

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

function lanAddress() {
  return pickLanAddress(lanCandidates(os.networkInterfaces()), primaryInterfaceName());
}

module.exports = { isPrivateIPv4, lanCandidates, primaryInterfaceName, pickLanAddress, lanAddress };
