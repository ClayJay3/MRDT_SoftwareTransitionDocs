// The shared gear service.
//
// The docs site is a static build served by nginx, which cannot write anything
// down. The signal studio's library has to be writable by the team and the same
// for everyone, so it gets this: a small Node service on the same compose
// network, behind the same Traefik router and the same Authentik middleware as
// the site itself.
//
// It holds three collections. Antennas and radios are parts; benches are whole
// saved setups. They differ only in what a valid one looks like, so they share
// one endpoint, one file and one set of rules about who may change what.
//
// Two consequences of sitting behind that router are worth knowing, because
// they are why this file is as short as it is:
//
//   * It is served from the SAME origin as the site, so there is no CORS to
//     configure and the browser sends the session cookie unasked.
//   * Whether Authentik has authenticated the caller depends on which mount
//     they came in through, and the service is told by the presence of the
//     header below rather than by having to know the routing:
//
//       /api         behind Authentik. The header is set from the auth answer,
//                    so the name on it can be trusted and an item can belong to
//                    someone.
//       /public-api  public, because the studio is a public page. Traefik
//                    strips the header there, so callers arrive anonymous and
//                    cannot pretend otherwise. Reads and new items, nothing
//                    that requires being anyone.
//
//     The second one is an open write endpoint on the internet, which is what
//     the rate limit on that router is for. Validation was always the job here
//     and is unchanged: it is a different thing from authentication and does
//     not become more or less necessary because of who is calling.
//
// No dependencies. Storage is one JSON file on a volume, which is enough for a
// library of this size and has the useful property that you can read it, grep
// it, back it up and edit it by hand when something goes wrong.

import {createServer} from 'node:http';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

const PORT = Number(process.env.PORT || 8080);
const DATA = process.env.GEAR_DATA || process.env.BENCH_DATA || '/data/gear.json';
const MODERATOR = process.env.MODERATOR_TOKEN || '';
// Authentik's forward auth sets this on the way through, and Traefik deletes
// whatever the client sent before setting it. Trustworthy only because nothing
// reaches this service except through Traefik, and because the one route that
// has no forward auth in front of it strips this header rather than passing it
// on. Absent means anonymous; it never means "believe the body instead".
const USER_HEADER = process.env.USER_HEADER || 'x-authentik-username';

const MAX_BODY = 16384;
const MAX_ITEMS = 2000; // per collection

const KINDS = ['antennas', 'radios', 'benches'];
const EMPTY = () => ({antennas: [], radios: [], benches: []});

// Keys the propagation model actually has. Whatever lands in a bench's params
// gets spread over the studio's own parameters when it is loaded, so this list
// is the boundary that stops a saved item setting something the UI never meant
// to expose.
const PARAM_KEYS = new Set([
  'band', 'width', 'distance', 'baseH', 'roverH', 'ridgeH', 'ridgeD',
  'baseTx', 'baseGain', 'baseHBeam', 'baseVBeam', 'baseCable', 'baseKind',
  'baseRefMHz', 'roverRefMHz', 'baseChains', 'baseXpol', 'roverChains',
  'roverXpol', 'downtilt', 'bearing', 'roverTx', 'roverGain', 'roverCable',
  'tilt', 'reg', 'interference', 'ackSet', 'site', 'baseE', 'baseN',
  'aim', 'heading',
]);

// Fields a part may carry. The studio normalizes these into real antennas and
// radios on the way in, so the job here is to refuse anything of the wrong
// shape or absurd size rather than to understand what a beamwidth means.
const ANTENNA_KEYS = new Set([
  'kind', 'ref', 'gain', 'hBeam', 'vBeam', 'feed', 'chains', 'pol',
  'price', 'qty', 'note',
]);
const RADIO_KEYS = new Set(['family', 'streams', 'backoffTop', 'eth', 'price', 'note', 'bands']);
const BAND_KEYS = new Set(['txMax', 'widths', 'sens0', 'sensTop']);

const SLOT_KEYS = ['baseRadio', 'roverRadio', 'baseAnt', 'roverAnt'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6 ? v : null);

// A flat bag of scalars, filtered to an allowlist. Everything the studio saves
// is ultimately this shape, so one function covers all three kinds.
function scalars(obj, allowed, maxString = 40) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!allowed.has(k)) continue;
    if (typeof v === 'number') {
      const n = num(v);
      if (n === null) return `${k} out of range`;
      out[k] = n;
    } else if (typeof v === 'boolean') {
      out[k] = v;
    } else if (typeof v === 'string') {
      out[k] = clean(v, k === 'note' ? 240 : maxString);
    }
  }
  return out;
}

// Reject anything structural, trim anything cosmetic.
function validate(kind, input, user) {
  if (!input || typeof input !== 'object') return 'not an object';
  const name = clean(input.name, 60);
  if (name.length < 3) return 'name must be at least 3 characters';

  const base = {
    name,
    // Whoever the auth layer says is signed in, never whoever the body claims.
    // Falling back to input.by was harmless while every caller had already been
    // through Authentik and the field was only ever a convenience. On a public
    // mount it is a way to sign someone else's name to a part, so it is gone:
    // no header, no name.
    by: user || 'anonymous',
    note: clean(input.note, 300),
  };

  if (kind === 'antennas') {
    const fields = scalars(input, ANTENNA_KEYS);
    if (typeof fields === 'string') return fields;
    return {...base, ...fields};
  }

  if (kind === 'radios') {
    const fields = scalars(input, RADIO_KEYS);
    if (typeof fields === 'string') return fields;
    const bands = {};
    for (const [id, spec] of Object.entries(input.bands || {})) {
      if (!/^[0-9.]{1,4}$/.test(id)) return 'bad band id';
      const b = scalars(spec, BAND_KEYS);
      if (typeof b === 'string') return `bands.${id}: ${b}`;
      const widths = Array.isArray(spec && spec.widths) ? spec.widths.map(num).filter((w) => w) : [];
      bands[id] = {...b, widths: widths.slice(0, 8)};
    }
    if (!Object.keys(bands).length) return 'a radio needs at least one band';
    return {...base, ...fields, bands};
  }

  // benches
  const slots = {};
  for (const k of SLOT_KEYS) {
    const v = clean(input.slots && input.slots[k], 64).toLowerCase();
    if (!ID_RE.test(v)) return `slots.${k} is not a gear id`;
    slots[k] = v;
  }
  const params = scalars(input.params, PARAM_KEYS, 12);
  if (typeof params === 'string') return `params.${params}`;
  const tags = (Array.isArray(input.tags) ? input.tags : [])
    .map((t) => clean(t, 24).toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
  return {...base, tags, slots, params};
}

const slug = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';

// ------------------------------------------------------------------ storage

// One in-flight write at a time. Node is single threaded, but a read, a modify
// and a write are three awaits, and two overlapping saves across them would
// lose one. Chaining every mutation onto the last keeps that honest.
let queue = Promise.resolve();
const serialize = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

async function readAll() {
  try {
    const raw = await readFile(DATA, 'utf8');
    const data = JSON.parse(raw);
    const out = EMPTY();
    for (const k of KINDS) if (Array.isArray(data[k])) out[k] = data[k];
    return out;
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY();
    // A corrupt file should not take the library offline for everyone, but it
    // must be loud, and it must not be silently overwritten by the next write.
    console.error(`[gear] cannot read ${DATA}:`, err.message);
    throw err;
  }
}

// Write beside the target and rename, so a crash mid-write leaves the previous
// library intact rather than half a file.
async function writeAll(data) {
  await mkdir(dirname(DATA), {recursive: true});
  const tmp = `${DATA}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DATA);
}

// ------------------------------------------------------------------- routing

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      if (size > MAX_BODY) return; // already rejected, drain quietly
      size += c.length;
      if (size > MAX_BODY) {
        // Stop reading but do NOT destroy the socket here. Destroying it takes
        // the response with it, and the caller ends up with a connection reset
        // instead of the 413 that would have told them what was wrong.
        req.pause();
        reject(new Error('too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Tolerate being mounted with or without the /api prefix, so the service can
  // be reached directly on the compose network for debugging.
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const user = clean(req.headers[USER_HEADER], 40);
  const isMod = Boolean(MODERATOR) && req.headers['x-moderator'] === MODERATOR;

  try {
    if (req.method === 'GET' && path === '/health') {
      await readAll();
      return send(res, 200, {ok: true});
    }

    // The whole library in one round trip, because the studio wants all of it
    // at once and none of it is large.
    if (req.method === 'GET' && (path === '/gear' || path === '/')) {
      const data = await readAll();
      return send(res, 200, {...data, you: user || null, moderator: isMod});
    }

    const post = path.match(/^\/gear\/([a-z]+)$/);
    if (req.method === 'POST' && post && KINDS.includes(post[1])) {
      const kind = post[1];
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch (err) {
        const tooBig = err.message === 'too large';
        send(res, tooBig ? 413 : 400, {error: err.message});
        // Now that the answer is on its way, stop the rest of the upload.
        if (tooBig) req.destroy();
        return undefined;
      }

      const checked = validate(kind, input, user);
      if (typeof checked === 'string') return send(res, 400, {error: checked});

      const outcome = await serialize(async () => {
        const data = await readAll();
        const list = data[kind];

        // An id that already exists is an edit, and only its owner may make
        // one. Everything else is a new item.
        const wanted = clean(input.id, 64).toLowerCase();
        const existing = wanted ? list.find((x) => x.id === wanted) : null;
        if (existing && !isMod && !(user && existing.by === user)) {
          return {status: 403, body: {error: 'you can only change items you saved'}};
        }
        if (!existing && list.length >= MAX_ITEMS) {
          return {status: 507, body: {error: 'library is full'}};
        }

        let id = existing ? existing.id : slug(checked.name);
        if (!existing) {
          // Names collide, ids must not. Only add a suffix when one is needed,
          // so the common case gives a link you can read.
          const taken = new Set(list.map((x) => x.id));
          const stem = id;
          for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
        }

        const item = {
          ...checked,
          id,
          // An edit keeps its original author and gains an edited stamp.
          by: existing ? existing.by : checked.by,
          added: existing ? existing.added : new Date().toISOString().slice(0, 10),
          ...(existing ? {edited: new Date().toISOString().slice(0, 10)} : {}),
        };
        data[kind] = existing ? list.map((x) => (x.id === id ? item : x)) : [item, ...list];
        await writeAll(data);
        return {status: existing ? 200 : 201, body: {ok: true, kind, item}};
      });

      return send(res, outcome.status, outcome.body);
    }

    const del = path.match(/^\/gear\/([a-z]+)\/([^/]+)$/);
    if (req.method === 'DELETE' && del && KINDS.includes(del[1])) {
      const kind = del[1];
      const id = decodeURIComponent(del[2]);

      const outcome = await serialize(async () => {
        const data = await readAll();
        const found = data[kind].find((x) => x.id === id);
        if (!found) return {status: 404, body: {error: 'no such item'}};
        if (!isMod && !(user && found.by === user)) {
          return {status: 403, body: {error: 'you can only remove items you saved'}};
        }
        data[kind] = data[kind].filter((x) => x.id !== id);
        await writeAll(data);
        return {status: 200, body: {ok: true, kind, removed: id}};
      });

      return send(res, outcome.status, outcome.body);
    }

    return send(res, 404, {error: 'not found'});
  } catch (err) {
    console.error('[gear]', err);
    return send(res, 500, {error: 'server error'});
  }
});

server.listen(PORT, () => {
  console.log(`[gear] listening on ${PORT}, storing ${DATA}`);
});
