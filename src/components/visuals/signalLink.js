// Putting a bench in a URL.
//
// The gear library is shared, but a link is still the unit of "look at this
// exact thing right now": it carries the whole bench, including slider
// positions nobody would bother saving, and it survives being pasted into a
// chat window. Saving is for things worth keeping; a link is for things worth
// showing.
//
// Two things keep it short enough to paste:
//
//   * only what DIFFERS from the defaults is encoded, so a link that changed
//     two sliders carries two sliders;
//   * radios travel as ids, not as objects, because a radio is a 300-byte spec
//     and the other end can look it up. Falling back to the live bench's radio
//     if the id is one of theirs rather than one of ours.
//
// Everything here is pure and guards its own access to window, so it is safe to
// import from a server-rendered module.

import {DEFAULTS} from './signalModel';

export const LINK_PARAM = 'bench';
export const LINK_VERSION = 1;

// URL-safe base64 both ways, without dragging in a dependency. The atob/btoa
// pair exists in every browser and in Node, which is what the test harness runs.
const b64 = {
  encode(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const raw = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
    return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s) {
    const raw = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = typeof atob === 'function' ? atob(raw) : Buffer.from(raw, 'base64').toString('binary');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  },
};

// Floats that came off a slider can arrive as 3.0000000000000004; rounding on
// the way out keeps the payload short and the round-trip exact.
const tidy = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);

// Where the two ends are standing always travels, even when it matches the
// baseline. Everything else on this bench is a number you can re-derive from
// the rest of the link, but geometry is the one thing the other end cannot
// guess: it merges what arrives onto ITS opening bench, and any position the
// diff leaves out silently becomes that bench's position instead of yours.
// Whoever opens the link is then looking at a base and a rover parked
// somewhere you never put them, with every dB downstream computed off the
// wrong path. Five keys is a cheap price for the link meaning what it says.
export const GEOMETRY_KEYS = ['site', 'baseE', 'baseN', 'aim', 'heading'];

// `base` is the bench the other end will merge this onto, and it MUST be the
// same object the reader starts from or the diff is against the wrong thing.
// The studio opens on a site rather than on the model's bare defaults, so it
// passes its own; the parameter exists so those two can never drift apart
// again.
export function encodeBench(p, slots, base = DEFAULTS) {
  const diff = {};
  for (const [k, v] of Object.entries(p)) {
    // Radios are objects; they travel as the slot ids below instead.
    if (k === 'baseRadio' || k === 'roverRadio') continue;
    if (GEOMETRY_KEYS.includes(k) || tidy(v) !== tidy(base[k])) diff[k] = tidy(v);
  }
  return b64.encode(JSON.stringify({v: LINK_VERSION, p: diff, s: slots || undefined}));
}

// Returns null for anything it does not recognise. A bad link should drop you on
// the default bench, not on a blank page or a half-applied one.
export function decodeBench(token) {
  if (!token) return null;
  try {
    const obj = JSON.parse(b64.decode(token));
    if (!obj || obj.v !== LINK_VERSION || typeof obj.p !== 'object') return null;
    const p = {};
    // Only keys the model actually has, and only of the type it expects, so a
    // hand-edited link cannot inject a shape solve() will trip over.
    for (const [k, v] of Object.entries(obj.p)) {
      if (!(k in DEFAULTS)) continue;
      if (typeof v !== typeof DEFAULTS[k]) continue;
      p[k] = v;
    }
    const s = obj.s && typeof obj.s === 'object' ? obj.s : null;
    return {p, slots: s};
  } catch {
    return null;
  }
}

// Read the bench out of the address bar. Browser only; server rendering has no
// query string to read and must fall through to the defaults.
export function benchFromLocation() {
  if (typeof window === 'undefined') return null;
  const token = new URLSearchParams(window.location.search).get(LINK_PARAM);
  return decodeBench(token);
}

export function benchUrl(p, slots, base) {
  if (typeof window === 'undefined') return '';
  const u = new URL(window.location.href);
  u.searchParams.set(LINK_PARAM, encodeBench(p, slots, base));
  u.hash = '';
  return u.toString();
}

// Keep the address bar in step without pushing history: dragging a slider must
// not fill the back button with a hundred entries.
export function syncLocation(p, slots, base) {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  window.history.replaceState(null, '', benchUrl(p, slots, base));
}
