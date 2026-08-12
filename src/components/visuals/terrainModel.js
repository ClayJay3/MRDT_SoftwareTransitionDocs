// Terrain maths for SignalLab's map view: sampling the baked heightmap, cutting
// a path profile out of it, and scoring what that profile does to the link.
//
// Everything here is pure and synchronous so the component stays SSR safe.

import {
  FINE_GRID,
  GRID,
  SITES,
  SPAN_M,
  STEP_M,
  gridIsFine,
  heightGrid,
  installFine,
} from '../../data/terrain';

export {FINE_GRID, GRID, SPAN_M, STEP_M, SITES, gridIsFine, heightGrid};

// Every grid knows its own side length, so nothing here has to care whether it
// is holding the bundled 200x200 or the fetched 512x512.
const sideOf = (grid) => grid.n || GRID;

// ------------------------------------------------------- fetching the fine grid
//
// The bundled grid is 30 m a sample, which is coarser than the 3DEP data it came
// from and coarse enough to miss the small rises that decide whether a path
// clears. The finer one is a plain int16 file under static/, so it is fetched
// once per site, cached by the browser like any other asset, and installed
// underneath a model that stays entirely synchronous — solve() keeps calling
// heightGrid() and simply starts getting better ground back.
//
// Failure is not an error condition: no network, a 404, a truncated read all
// leave the coarse grid in place and the page working.

// `url` is the site's `fine` path already run through Docusaurus' baseUrl, which
// only a component can do — so the caller supplies it rather than this module
// guessing where the site is mounted.
const pending = new Map();

export function loadFineGrid(id, url) {
  if (typeof fetch === 'undefined') return Promise.resolve(false);
  if (gridIsFine(id)) return Promise.resolve(false);
  if (pending.has(id)) return pending.get(id);

  const site = SITES.find((s) => s.id === id);
  if (!site || !site.fine || !url) return Promise.resolve(false);

  const job = fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .then((buf) => (buf ? installFine(id, buf) : false))
    .catch(() => false)
    // A failed fetch is allowed to be retried by a later mount; a successful one
    // never runs again because gridIsFine short-circuits above.
    .finally(() => pending.delete(id));

  pending.set(id, job);
  return job;
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const log10 = (x) => Math.log(x) / Math.LN10;
const lambdaM = (fMHz) => 299.792458 / fMHz;

// Effective earth radius. The bulge is only about 0.4 m at 5 km, but once the
// profile is real terrain it costs nothing to be correct about it.
const EARTH_R = 6371000;
const K_FACTOR = 4 / 3;

// ---------------------------------------------------------------- sampling

// Bilinear sample of the heightmap. e and n are metres east and north of the
// site centre. Outside the map we clamp to the edge, which reads as "flat from
// here on" rather than as a cliff.
export function sampleHeight(grid, e, n) {
  const g = sideOf(grid);
  const step = SPAN_M / (g - 1);
  const half = SPAN_M / 2;
  const cx = clamp((e + half) / step, 0, g - 1.001);
  const cy = clamp((half - n) / step, 0, g - 1.001);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const x1 = Math.min(x0 + 1, g - 1);
  const y1 = Math.min(y0 + 1, g - 1);
  return (
    grid[y0 * g + x0] * (1 - fx) * (1 - fy) +
    grid[y0 * g + x1] * fx * (1 - fy) +
    grid[y1 * g + x0] * (1 - fx) * fy +
    grid[y1 * g + x1] * fx * fy
  );
}

// How far you can travel from (e, n) on the given compass bearing before
// leaving the map. Used to stop the range sweep at the edge of real data.
export function distanceToEdge(e, n, bearingDeg) {
  const half = SPAN_M / 2;
  const th = (bearingDeg * Math.PI) / 180;
  const de = Math.sin(th);
  const dn = Math.cos(th);
  let t = Infinity;
  if (Math.abs(de) > 1e-9) t = Math.min(t, ((de > 0 ? half : -half) - e) / de);
  if (Math.abs(dn) > 1e-9) t = Math.min(t, ((dn > 0 ? half : -half) - n) / dn);
  return Math.max(0, Math.min(t, SPAN_M * 1.5));
}

// Terrain profile from base to rover, with the effective-earth bulge folded in
// so everything downstream can treat the line of sight as a straight line.
export function pathProfile(grid, bE, bN, rE, rN, D, n = 64) {
  const out = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const d1 = t * D;
    const d2 = D - d1;
    out[i] =
      sampleHeight(grid, bE + (rE - bE) * t, bN + (rN - bN) * t) +
      (d1 * d2) / (2 * K_FACTOR * EARTH_R);
  }
  return out;
}

// ------------------------------------------------------------- diffraction

// ITU-R P.526 single knife-edge loss, as a function of the Fresnel-Kirchhoff
// parameter. Shared with the synthetic single-ridge model in SignalLab.
export function jv(v) {
  if (v <= -0.78) return 0;
  return 6.9 + 20 * log10(Math.sqrt(Math.pow(v - 0.1, 2) + 1) + v - 0.1);
}

function vAt(h, d1, d2, fMHz) {
  if (d1 <= 0 || d2 <= 0) return -Infinity;
  return h * Math.sqrt((2 * (d1 + d2)) / (lambdaM(fMHz) * d1 * d2));
}

// One Deygout pass: find the point that pokes furthest into the Fresnel zone of
// the chord from A to B, charge for it, then recurse into the two sub-spans.
function deygoutSpan(prof, dx, iA, iB, hA, hB, fMHz, depth) {
  if (iB - iA < 2) return 0;
  let bestV = -Infinity;
  let bi = -1;
  for (let i = iA + 1; i < iB; i++) {
    const d1 = (i - iA) * dx;
    const d2 = (iB - i) * dx;
    const los = hA + ((hB - hA) * (i - iA)) / (iB - iA);
    const v = vAt(prof[i] - los, d1, d2, fMHz);
    if (v > bestV) {
      bestV = v;
      bi = i;
    }
  }
  if (bi < 0 || bestV <= -0.78) return 0;
  let loss = jv(bestV);
  if (depth > 0) {
    loss += deygoutSpan(prof, dx, iA, bi, hA, prof[bi], fMHz, depth - 1);
    loss += deygoutSpan(prof, dx, bi, iB, prof[bi], hB, fMHz, depth - 1);
  }
  return loss;
}

// Deygout multi-edge diffraction, stopped at three edges: the dominant
// obstruction plus one subsidiary either side of it. Deygout is the standard
// practical construction, but it over-predicts when several edges are of
// comparable height, which is exactly why it is capped rather than run deep.
export function diffractionLoss(prof, D, hTx, hRx, fMHz) {
  const n = prof.length - 1;
  return deygoutSpan(prof, D / n, 0, n, hTx, hRx, fMHz, 1);
}

// Worst Fresnel clearance anywhere on the path, as a fraction of the first
// Fresnel radius. Positive means the zone is clear, negative means terrain is
// inside it. Also reports where the pinch happens.
export function worstClearance(prof, D, hTx, hRx, fMHz) {
  const n = prof.length - 1;
  const dx = D / n;
  let worst = Infinity;
  let at = D / 2;
  for (let i = 1; i < n; i++) {
    const d1 = i * dx;
    const d2 = D - d1;
    const f1 = Math.sqrt((lambdaM(fMHz) * d1 * d2) / D);
    if (f1 <= 0) continue;
    const los = hTx + ((hRx - hTx) * i) / n;
    const c = (los - prof[i]) / f1;
    if (c < worst) {
      worst = c;
      at = d1;
    }
  }
  return {clearance: worst === Infinity ? 9 : worst, at};
}

// Least-squares line through the profile, which is the plane the ground
// reflection bounces off. Also returns the RMS departure from that line, which
// feeds the Rayleigh roughness term: broken ground scatters the specular ray
// away instead of returning it to cancel the direct one.
export function groundPlane(prof, D) {
  const n = prof.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * D;
    sx += x;
    sy += prof[i];
    sxx += x * x;
    sxy += x * prof[i];
  }
  const den = n * sxx - sx * sx;
  const slope = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const icpt = (sy - slope * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * D;
    const dv = prof[i] - (icpt + slope * x);
    ss += dv * dv;
  }
  return {h0: icpt, h1: icpt + slope * D, sigma: Math.sqrt(ss / n)};
}

// ------------------------------------------------------------ map painting

// A classic hypsometric ramp, low ground green through to pale high ground.
// Chosen to sit legibly on both the light and dark Docusaurus themes, since the
// bands cover the whole map area and carry their own contrast.
const RAMP = [
  [0.0, [31, 68, 54]],
  [0.3, [92, 127, 58]],
  [0.55, [176, 154, 74]],
  [0.78, [154, 107, 63]],
  [1.0, [232, 220, 200]],
];

export function bandColor(t) {
  const x = clamp(t, 0, 1);
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const [a, ca] = RAMP[i - 1];
      const [b, cb] = RAMP[i];
      const f = (x - a) / (b - a);
      const c = ca.map((v, j) => Math.round(v + (cb[j] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return `rgb(${RAMP[RAMP.length - 1][1].join(',')})`;
}

// Turn the heightmap into one filled <path> per elevation band, in a 0..1000
// square. Runs of same-band cells on a row are merged, which collapses a
// 120x120 grid down to a couple of thousand rectangles across a dozen paths.
// Memoise this per site: it does not depend on anything the user drags.
export function contourBands(id, nBands = 12, DG = 120) {
  const grid = heightGrid(id);
  const g = sideOf(grid);
  const site = SITES.find((s) => s.id === id) || SITES[0];
  const lo = site.min;
  const span = Math.max(site.max - site.min, 1);

  const band = new Uint8Array(DG * DG);
  for (let r = 0; r < DG; r++) {
    const gr = Math.round((r * (g - 1)) / (DG - 1));
    for (let c = 0; c < DG; c++) {
      const gc = Math.round((c * (g - 1)) / (DG - 1));
      band[r * DG + c] = clamp(Math.floor(((grid[gr * g + gc] - lo) / span) * nBands), 0, nBands - 1);
    }
  }

  const cell = 1000 / DG;
  const parts = Array.from({length: nBands}, () => []);
  for (let r = 0; r < DG; r++) {
    const y = +(r * cell).toFixed(1);
    const h = +(cell + 0.35).toFixed(2); // hairline overlap kills seam artefacts
    let c = 0;
    while (c < DG) {
      const b = band[r * DG + c];
      let e = c + 1;
      while (e < DG && band[r * DG + e] === b) e++;
      const x = +(c * cell).toFixed(1);
      const w = +((e - c) * cell + 0.35).toFixed(2);
      parts[b].push(`M${x},${y}h${w}v${h}h${-w}z`);
      c = e;
    }
  }

  return parts.map((d, i) => ({
    d: d.join(''),
    fill: bandColor(nBands === 1 ? 0 : i / (nBands - 1)),
    lo: lo + (span * i) / nBands,
    hi: lo + (span * (i + 1)) / nBands,
  }));
}
