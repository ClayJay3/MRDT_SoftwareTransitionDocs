// Talking to the shared gear service.
//
// The site is static, so this is the one thing on it that reaches a server. It
// holds the library: antennas, radios and saved benches, the same for everyone
// who can see the page.
//
// Written so that the server not existing is a normal state rather than an
// error. Unreachable, blocked, or simply not deployed all end up in the same
// place: the studio shows the built-in parts plus whatever was cached from the
// last successful visit, and saving is disabled with a reason.
//
// The service validates everything it stores. This validates everything it
// renders, which is not the same job. A response from a service that has got
// ahead of or behind this file must not be able to put a key into the studio's
// parameter bag that the model does not have.

import {DEFAULTS} from './signalModel';
import {normalizeAntenna, normalizeRadioSpec} from './signalGear';
import {normalizeBench} from '../../data/benches';

// One service, mounted twice on this origin, and which mount answers is what
// tells the studio who you are.
//
//   /api         is behind Authentik. Reaching it means the auth layer put your
//                name on the request, which is what makes an item yours and
//                therefore yours to change.
//   /public-api  is not behind anything, because the studio is a public page.
//                Anyone gets to read the library and add to it, as `anonymous`.
//
// Same origin either way, so there is no CORS and the session cookie the page
// already has goes along without being asked for.
const PRIVATE_BASE = '/api';
const PUBLIC_BASE = '/public-api';

// Which mount answered when the library was last loaded. Writes follow reads:
// there is no point posting to a door that did not open. Public until proven
// otherwise, so a save that somehow beats the first load still goes somewhere
// that will take it.
let base = PUBLIC_BASE;

// Short, because the fallback is good and a slow library is worse than a
// missing one.
const TIMEOUT_MS = 5000;

// The last good response, so a visit with the server down still shows the gear
// you saved rather than an empty library. A cache, never the source of truth:
// anything written goes to the server first and lands here as a consequence.
const CACHE_KEY = 'mrdt.signal-studio.gear-cache.v2';

export const EMPTY_LIBRARY = {antennas: [], radios: [], benches: []};

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);

// Drop anything the model does not have, and anything of the wrong type for the
// key it claims to be. Same rule the share links use, for the same reason.
function safeParams(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (!(k in DEFAULTS)) continue;
    if (typeof v !== typeof DEFAULTS[k]) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}

// Everything off the wire carries who saved it and when, on top of whatever the
// studio's own normalizers make of it. `origin` marks where an item came from,
// because the two are not the same promise: a built-in was reviewed into the
// repo and will be there next year, a saved one was not and can be removed.
const stamp = (raw, item) => ({
  ...item,
  by: typeof raw.by === 'string' ? raw.by : 'anonymous',
  added: typeof raw.added === 'string' ? raw.added : '',
  edited: typeof raw.edited === 'string' ? raw.edited : '',
  origin: 'shared',
});

export const fromServer = {
  antennas: (raw) => stamp(raw, normalizeAntenna(raw)),
  radios: (raw) => stamp(raw, normalizeRadioSpec(raw)),
  benches: (raw) => {
    const b = normalizeBench(raw);
    return stamp(raw, {...b, params: safeParams(b.params), id: b.id || 'bench'});
  },
};

const shape = (data) => ({
  antennas: (Array.isArray(data.antennas) ? data.antennas : []).map(fromServer.antennas),
  radios: (Array.isArray(data.radios) ? data.radios : []).map(fromServer.radios),
  benches: (Array.isArray(data.benches) ? data.benches : []).map(fromServer.benches),
});

// ------------------------------------------------------------------- cache

export function readCache() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? shape(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeCache(library) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(library));
  } catch {
    // A full or disabled localStorage costs you the offline copy and nothing
    // else, so there is nothing useful to do about it here.
  }
}

// ------------------------------------------------------------------ reading

// One mount's answer, or a throw. `redirect: 'error'` is doing real work here:
// signed out, Authentik answers the private mount with a bounce to a login page
// on another host, and following it would cost a cross-origin round trip and a
// console full of CORS to arrive at some HTML that was never going to parse.
// Refusing the redirect fails it immediately instead, which is the same answer
// sooner. A JSON body is the only thing that counts as the door opening.
async function loadFrom(from) {
  const res = await withTimeout(
    fetch(`${from}/gear`, {
      headers: {accept: 'application/json'},
      credentials: 'same-origin',
      redirect: 'error',
    }),
    TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`server said ${res.status}`);
  return res.json();
}

export async function fetchLibrary() {
  // Both at once, because a signed-out visitor would otherwise wait out the
  // private mount before the public one even started. Ordered by preference,
  // not by speed: if the private mount answered at all then you are signed in,
  // and its answer is the one that knows your name.
  const tried = [PRIVATE_BASE, PUBLIC_BASE];
  const settled = await Promise.allSettled(tried.map(loadFrom));
  const winner = settled.findIndex((r) => r.status === 'fulfilled');

  if (winner >= 0) {
    base = tried[winner];
    const data = settled[winner].value;
    const library = shape(data);
    writeCache(library);
    return {
      ok: true,
      library,
      // Who the service says you are, from the auth layer in front of it, and
      // whether it accepted a moderator token. Both decide what you may change.
      you: typeof data.you === 'string' ? data.you : null,
      moderator: Boolean(data.moderator),
      cached: false,
    };
  }

  // Neither mount answered. Report the public one's complaint: the private one
  // failing is the normal state of being signed out and says nothing about
  // whether the service is up.
  const err = settled[tried.indexOf(PUBLIC_BASE)].reason || {};
  const cached = readCache();
  return {
    ok: false,
    reason: err.message === 'timeout' ? 'not answering' : err.message || 'unreachable',
    library: cached || EMPTY_LIBRARY,
    you: null,
    moderator: false,
    cached: Boolean(cached),
  };
}

// ------------------------------------------------------------------ writing

// Saving something already carrying an id is an edit, which the service allows
// only for whoever saved it in the first place.
//
// Writes go to whichever mount the last read came back from. Signed in that is
// the private one, so the service knows whose the item is; signed out it is the
// public one and the item is anonymous.
export async function saveItem(kind, item) {
  if (!item || !item.name || item.name.trim().length < 3) {
    return {ok: false, error: 'Give it a name of at least three characters.'};
  }
  try {
    const res = await withTimeout(
      fetch(`${base}/gear/${kind}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(item),
        // A session that expired between loading the page and saving would
        // otherwise bounce to a login page and come back as a cheerful 200 of
        // HTML, which is the one failure that must not read as success.
        redirect: 'error',
      }),
      TIMEOUT_MS,
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.item) {
      return {ok: false, error: (data && data.error) || `server said ${res.status}`};
    }
    return {ok: true, item: fromServer[kind](data.item)};
  } catch (err) {
    return {
      ok: false,
      error: err.message === 'timeout' ? 'The server did not answer.' : 'Could not reach the server.',
    };
  }
}

export async function deleteItem(kind, id) {
  try {
    const res = await withTimeout(
      fetch(`${base}/gear/${kind}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        redirect: 'error',
      }),
      TIMEOUT_MS,
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.ok) {
      return {ok: false, error: (data && data.error) || `server said ${res.status}`};
    }
    return {ok: true};
  } catch {
    return {ok: false, error: 'Could not reach the server.'};
  }
}
