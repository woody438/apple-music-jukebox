'use strict';

// Apple's scripting bridge is inconsistent about enum spelling: JXA may hand
// back 'noLongerAvailable', 'no longer available' or 'NoLongerAvailable' for
// the same value depending on version. Flatten all of it to spaced lowercase.
function normaliseEnum(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Cloud states where pressing play produces silence or an error dialog.
const BLOCKED_CLOUD_STATUS = new Set([
  'ineligible',
  'removed',
  'error',
  'no longer available',
  'prerelease',
]);

function isPlayableCloudStatus(raw) {
  // An absent cloud status means a plain local file, which is fine.
  const s = normaliseEnum(raw);
  if (!s) return true;
  return !BLOCKED_CLOUD_STATUS.has(s);
}

function isSong(rawMediaKind) {
  return normaliseEnum(rawMediaKind) === 'song';
}

// AppleScript booleans arrive as real booleans through JXA, but be defensive:
// only an explicit false (or 'false') disables a track.
function isEnabled(raw) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'boolean') return raw;
  const s = normaliseEnum(raw);
  return !(s === 'false' || s === 'no' || s === '0');
}

function normalisePlayerState(raw) {
  const s = normaliseEnum(raw);
  if (s.indexOf('play') === 0) return 'playing';
  if (s.indexOf('paus') === 0) return 'paused';
  if (s.indexOf('stop') === 0) return 'stopped';
  if (s === 'fast forwarding' || s === 'rewinding') return 'playing';
  return s || 'stopped';
}

// Strip accents and case so "Beyoncé" matches "beyonce".
function fold(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Browse order ignores a leading article on the artist name.
function artistSortKey(artist) {
  const a = fold(artist).trim();
  const stripped = a.replace(/^(the|a|an)\s+/, '');
  return stripped || a;
}

// Bucket letter for the A-Z rail and the selection code.
function railLetter(artist) {
  const k = artistSortKey(artist);
  const c = k.charAt(0);
  return c >= 'a' && c <= 'z' ? c.toUpperCase() : '#';
}

function clamp(n, lo, hi) {
  n = Number(n);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

module.exports = {
  normaliseEnum,
  BLOCKED_CLOUD_STATUS,
  isPlayableCloudStatus,
  isSong,
  isEnabled,
  normalisePlayerState,
  fold,
  artistSortKey,
  railLetter,
  clamp,
};
