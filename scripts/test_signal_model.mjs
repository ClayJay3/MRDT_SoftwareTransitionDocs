// Test harness for the SignalLab propagation model.
//
// Runs against the shipped module, not a reimplementation, so a divergence
// between what is tested and what renders is impossible.
//
//   node scripts/test_signal_model.mjs
//
// The build treats src/**/*.js as ESM via bundler resolution; plain node needs
// .mjs shims, which this script writes into a temp directory on startup. There
// is nothing to set up by hand.

import {mkdtempSync, readFileSync, statSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');

const dir = mkdtempSync(join(tmpdir(), 'siglab-'));
const shim = (from, to, rewrite = (s) => s) =>
  writeFileSync(join(dir, to), rewrite(readFileSync(from, 'utf8')));

shim(join(src, 'data', 'terrain.js'), 'terrain.mjs');
shim(join(src, 'components', 'visuals', 'terrainModel.js'), 'terrainModel.mjs', (s) =>
  s.replace("'../../data/terrain'", "'./terrain.mjs'"));
shim(join(src, 'components', 'visuals', 'signalModel.js'), 'signalModel.mjs', (s) =>
  s.replace("'./terrainModel'", "'./terrainModel.mjs'"));
shim(join(src, 'components', 'visuals', 'signalGear.js'), 'signalGear.mjs', (s) =>
  s.replace("'./signalModel'", "'./signalModel.mjs'"));

const M = await import(`file://${join(dir, 'signalModel.mjs')}`);
const T = await import(`file://${join(dir, 'terrainModel.mjs')}`);
const G = await import(`file://${join(dir, 'signalGear.mjs')}`);
process.on('exit', () => rmSync(dir, {recursive: true, force: true}));

const {solve, DEFAULTS, PRESETS, BANDS, WIDTHS, PHY20, SENS20, TX_BACKOFF,
       STREAMS, MAC_EFFICIENCY, VIDEO_FLOOR, CONTROL_FLOOR, CONDUCTED_MAX,
       SHADOW_SIGMA, REF_MHZ, fspl, fresnel, dirFromBeamwidth, omniVBeam,
       rolloff, knifeEdge, qFunc, availabilityOf, allowedEirp,
       groundReflectionDb, clamp, sweepRange, PHY_FAMILIES, DEFAULT_RADIO,
       normalizeRadio, sensCurve, linkLimits, radioHasBand} = M;

const {BUILTIN_RADIOS, BUILTIN_ANTENNAS, normalizeAntenna, normalizeRadioSpec,
       applyBaseAntenna, applyRoverAntenna, baseMatches, roverMatches,
       reconcileLink, antennaFromBase, exportGear, importGear} = G;

// ------------------------------------------------------------------ runner

let pass = 0;
const fails = [];
let group = '';
const section = (g) => { group = g; console.log(`\n── ${g}`); };
function check(name, ok, detail = '') {
  if (ok) { pass++; return; }
  fails.push(`${group} :: ${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`   FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b, tol, name, d = '') =>
  check(name, Math.abs(a - b) <= tol, d || `${a} vs ${b} (tol ${tol})`);

const P = (o = {}) => ({...DEFAULTS, ...o});

// Infinity is a deliberate sentinel in exactly these places: no Part 15 ceiling
// when the rules are switched off, and no finite airtime when a direction
// carries nothing. Everything else must be a real number.
const MAY_BE_INFINITE = /^r\.(capBase|capRover|airtime|(up|down)\.air)$/;

function allFinite(r, path = 'r') {
  const bad = [];
  const walk = (o, p) => {
    if (o === null || o === undefined) return;
    if (typeof o === 'number') {
      if (!Number.isFinite(o) && !MAY_BE_INFINITE.test(p)) bad.push(p);
      if (Number.isNaN(o)) bad.push(`${p} (NaN)`);
      return;
    }
    if (typeof o !== 'object') return;
    if (ArrayBuffer.isView(o)) {
      for (let i = 0; i < o.length; i++) if (!Number.isFinite(o[i])) bad.push(`${p}[${i}]`);
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], `${p}.${k}`);
  };
  walk(r, path);
  return bad;
}

// ------------------------------------------------------- 1. physics kernels

section('1. physics kernels against closed form');

near(fspl(1000, 5800), 107.71, 0.02, 'FSPL 1 km @ 5.8 GHz');
near(fspl(1000, 2437), 100.19, 0.02, 'FSPL 1 km @ 2.4 GHz');
near(fspl(2000, 5800) - fspl(1000, 5800), 6.02, 0.01, 'FSPL doubles distance = +6 dB');
near(fresnel(500, 1000, 5800), 3.594, 0.005, 'Fresnel midpoint 1 km @ 5.8');
near(fresnel(500, 1000, 2437), 5.546, 0.005, 'Fresnel midpoint 1 km @ 2.4');
check('Fresnel is zero at both endpoints',
  fresnel(0, 1000, 5800) === 0 && fresnel(1000, 1000, 5800) === 0);
near(dirFromBeamwidth(20, 20), 20.13, 0.02, 'directivity 20°x20°');
near(dirFromBeamwidth(35, 35), 15.29, 0.02, 'directivity 35°x35°');
near(dirFromBeamwidth(66, 16), 15.91, 0.02, 'directivity 66°x16°');
near(omniVBeam(9), 14.43, 0.02, 'omni toroid height at 9 dBi');
near(rolloff(10, 20, 25), -3, 1e-9, 'rolloff is -3 dB at half the beamwidth');
check('rolloff floors at the sidelobe level', rolloff(180, 20, 25) === -25);
near(qFunc(0), 0.5, 1e-6, 'Q(0)');
near(qFunc(1.96), 0.025, 5e-4, 'Q(1.96)');
near(qFunc(-1.96), 0.975, 5e-4, 'Q(-1.96)');
near(availabilityOf(0), 0.5, 1e-6, 'zero margin = 50% availability');
check('availability is monotonic in margin',
  [...Array(80)].every((_, i) => availabilityOf(i - 40) <= availabilityOf(i - 39)));
near(T.jv(0), 6.02, 0.02, 'knife-edge J(0) = 6 dB');
check('knife edge is free below v = -0.78', T.jv(-0.79) === 0 && T.jv(-5) === 0);
check('knife-edge loss grows with v',
  [...Array(50)].every((_, i) => T.jv(i / 10) <= T.jv((i + 1) / 10)));
near(allowedEirp('ptmp', '5.8', 24), 36, 1e-9, 'Part 15 PtMP pins EIRP at 36 dBm');
near(allowedEirp('ptmp', '5.8', 6), 36, 1e-9, 'Part 15 PtMP at exactly 6 dBi');
near(allowedEirp('p2p', '5.8', 24), 54, 1e-9, 'Part 15 P2P on 5.8 gives gain for free');
near(allowedEirp('p2p', '2.4', 24), 54 - 6, 1e-9, 'Part 15 P2P on 2.4 gives back 1 dB per 3');
check('Part 15 "ignore" is unbounded', allowedEirp('off', '5.8', 24) === Infinity);

// Two-ray against the flat-earth asymptote 40log10(d) - 20log10(h1 h2).
for (const d of [1000, 2000, 5000]) {
  const modelled = fspl(d, 5800) + groundReflectionDb(d, 3, 1.2, 5800, 0.0);
  const asymptote = 40 * Math.log10(d) - 20 * Math.log10(3 * 1.2);
  near(modelled, asymptote, d >= 2000 ? 0.6 : 1.6, `two-ray vs flat-earth asymptote at ${d} m`);
}
check('two-ray asymptote is frequency independent',
  Math.abs((fspl(3000, 5800) + groundReflectionDb(3000, 3, 1.2, 5800, 0)) -
           (fspl(3000, 2437) + groundReflectionDb(3000, 3, 1.2, 2437, 0))) < 0.6);
check('ground reflection can be constructive before the crossover',
  groundReflectionDb(400, 3, 1.2, 5800, 0.1) < -3);
check('roughness suppresses the reflection',
  Math.abs(groundReflectionDb(1000, 3, 1.2, 5800, 8)) <
  Math.abs(groundReflectionDb(1000, 3, 1.2, 5800, 0.01)));

// HE rate table and width scaling against the 802.11ax data-subcarrier ratios.
near(PHY20[11] * STREAMS * WIDTHS[40].rate, 573.6, 0.1, 'MCS11 2SS 40 MHz = datasheet 574');
near(PHY20[11] * STREAMS * WIDTHS[80].rate * 2, 2403.6, 1.0, 'MCS11 2SS 160 MHz = datasheet 2400');
near(WIDTHS[80].rate, 980 / 234, 0.01, '80 MHz rate ratio matches subcarrier count');
for (const [w, spec] of Object.entries(WIDTHS))
  near(spec.sens, 10 * Math.log10(w / 20), 0.03, `${w} MHz noise floor shift`);

// -------------------------------------------------- 2. the rate-ladder fix

section('2. rate ladder: fade averaging and link-level uptime');

{
  // The exact configuration from the bug report: 2.4 GHz, p2p, MDRS, 1050 m,
  // rover omni set to 3.6 dBi at 5.8, pitched -4° vs +33°.
  const base = {band: '2.4', width: 20, reg: 'p2p', site: 'mdrs', distance: 1050,
                heading: 111, aim: 110, roverGain: 3.6, baseGain: 18};
  const a = solve(P({...base, tilt: -4}), 1050);
  const b = solve(P({...base, tilt: 33}), 1050);

  check('pitching the rover no longer flips reported link health',
    (a.down.linkAvail > 0.97) === (b.down.linkAvail > 0.97),
    `linkAvail ${a.down.linkAvail.toFixed(4)} vs ${b.down.linkAvail.toFixed(4)}`);
  check('link uptime is ~100% in both, because MCS0 has huge margin',
    a.down.linkAvail > 0.999 && b.down.linkAvail > 0.999);
  check('tipping the rover cannot increase capacity',
    b.down.capacity <= a.down.capacity + 1e-9,
    `${a.down.capacity.toFixed(2)} -> ${b.down.capacity.toFixed(2)} Mbps`);
  check('link margin reflects the bottom rung, not the chosen one',
    a.down.linkMargin > 20 && a.down.linkMargin > a.down.margin);
}

{
  // Capacity must be a *continuous* function of a continuous input. An absolute
  // Mbps threshold is the wrong test: next to a two-ray null the physics is
  // genuinely steep. Instead halve the input step and confirm the output step
  // halves with it — a real discontinuity would not shrink.
  const scan = (step, mk, pick, lo, hi) => {
    let worst = 0;
    let prev = null;
    for (let v = lo; v <= hi; v += step) {
      const c = pick(solve(mk(v), mk(v).distance));
      if (prev !== null) worst = Math.max(worst, Math.abs(c - prev));
      prev = c;
    }
    return worst;
  };

  const gainMk = (g) => P({baseGain: g, baseHBeam: 90, baseVBeam: 90, reg: 'off'});
  const g1 = scan(0.02, gainMk, (r) => r.down.capacity, 3, 24);
  const g2 = scan(0.01, gainMk, (r) => r.down.capacity, 3, 24);
  check('capacity is continuous in antenna gain (no rung-flip jumps)',
    g2 < g1 * 0.62, `step halved: ${g1.toFixed(4)} -> ${g2.toFixed(4)} Mbps`);

  const distMk = (d) => P({reg: 'off', baseGain: 12, baseHBeam: 60, baseVBeam: 60, distance: d});
  const d1v = scan(1, distMk, (r) => r.up.capacity, 100, 4000);
  const d2v = scan(0.5, distMk, (r) => r.up.capacity, 100, 4000);
  check('capacity is continuous in distance',
    d2v < d1v * 0.62, `step halved: ${d1v.toFixed(4)} -> ${d2v.toFixed(4)} Mbps`);

  const tiltMk = (t) => P({tilt: t, roverGain: 9});
  const t1 = scan(0.02, tiltMk, (r) => r.down.capacity, -45, 45);
  const t2 = scan(0.01, tiltMk, (r) => r.down.capacity, -45, 45);
  check('capacity is continuous in rover pitch — the reported bug',
    t2 < t1 * 0.62, `step halved: ${t1.toFixed(4)} -> ${t2.toFixed(4)} Mbps`);
}

check('fade-averaged capacity beats the single-rung product',
  (() => {
    const d = solve(P({distance: 1500}), 1500).down;
    const single = Math.max(...d.rungs.map((rg) => rg.phy * rg.avail));
    return d.expected >= single - 1e-9;
  })(), 'expectation must dominate any single rung');

check('expectation is bounded by the top PHY rate',
  (() => {
    for (const dist of [100, 500, 1500, 3000]) {
      const r = solve(P(), dist);
      for (const k of ['up', 'down'])
        if (r[k].expected > PHY20[11] * STREAMS + 1e-6) return false;
    }
    return true;
  })());

check('rung availability is non-increasing up the ladder',
  (() => {
    for (const dist of [200, 800, 1600, 3200]) {
      const r = solve(P({site: 'mdrs', heading: 15}), dist);
      for (const k of ['up', 'down'])
        for (let i = 1; i < r[k].rungs.length; i++)
          if (r[k].rungs[i].avail > r[k].rungs[i - 1].avail + 1e-12) return false;
    }
    return true;
  })());

check('the usual rate always closes when the link is up',
  (() => {
    for (let d = 50; d <= 4000; d += 50) {
      const r = solve(P({baseCable: 6}), d);
      for (const k of ['up', 'down']) if (r[k].up && r[k].margin < 0) return false;
    }
    return true;
  })());

check('link uptime >= the rate it holds',
  (() => {
    for (let d = 50; d <= 4000; d += 50) {
      const r = solve(P({baseCable: 9}), d);
      for (const k of ['up', 'down']) if (r[k].linkAvail < r[k].hold - 1e-12) return false;
    }
    return true;
  })());

// --------------------------------------------------------- 3. monotonicity

section('3. monotonicity: knobs must move the link the right way');

const mono = (name, mk, vals, pick, dir) => {
  let prev = null, bad = null;
  for (const v of vals) {
    const cur = pick(solve(mk(v), mk(v).distance));
    if (prev !== null) {
      const d = cur - prev;
      if (dir > 0 ? d < -1e-6 : d > 1e-6) bad = `at ${v}: ${prev.toFixed(3)} -> ${cur.toFixed(3)}`;
    }
    prev = cur;
  }
  check(name, !bad, bad || '');
};

const seq = (a, b, n) => [...Array(n)].map((_, i) => a + ((b - a) * i) / (n - 1));

mono('more TX power never hurts (Part 15 off)',
  (v) => P({reg: 'off', baseTx: v}), seq(5, 28, 24), (r) => r.down.capacity, +1);
mono('more cable loss never helps',
  (v) => P({baseCable: v}), seq(0, 20, 41), (r) => r.down.linkMargin, -1);
mono('more interference never helps',
  (v) => P({interference: v}), seq(-20, 25, 46), (r) => r.up.linkMargin, -1);
mono('more distance never helps on a clear path',
  (v) => P({distance: v}), seq(300, 2500, 45), (r) => r.up.linkMargin, -1);
mono('more antenna gain never hurts receive (Part 15 off)',
  (v) => P({reg: 'off', baseGain: v, baseHBeam: 120, baseVBeam: 120}), seq(3, 27, 25),
  (r) => r.up.linkMargin, +1);
mono('narrower channel never lowers link margin',
  (v) => P({width: v}), [80, 40, 20, 10], (r) => r.down.linkMargin, +1);
mono('wider channel never lowers capacity at short range',
  (v) => P({width: v, distance: 300}), [10, 20, 40, 80], (r) => r.down.capacity, +1);
mono('pointing further off boresight never helps',
  (v) => P({bearing: v}), seq(0, 90, 46), (r) => r.down.linkMargin, -1);
mono('pitching the rover further off-axis never helps',
  (v) => P({tilt: v, roverGain: 9}), seq(0, 45, 46), (r) => r.down.linkMargin, -1);
mono('a taller ridge never helps',
  (v) => P({ridgeH: v, ridgeD: 500}), seq(0, 20, 41), (r) => r.up.linkMargin, -1);
mono('more obstruction loss with a taller ridge',
  (v) => P({ridgeH: v, ridgeD: 500}), seq(0, 20, 41), (r) => r.obstruction, +1);

check('raising the mast on a clear path helps, via the ground reflection',
  (() => {
    const m = [1, 1.5, 2, 3, 4, 6].map((h) => solve(P({baseH: h}), 1000).down.linkMargin);
    return m.every((v, i) => i === 0 || v > m[i - 1]);
  })(), 'this is the two-ray crossover moving outward');

// ----------------------------------------------------- 4. hard invariants

section('4. invariants across a wide parameter sweep');

const bands = ['2.4', '5.8'];
const regs = ['ptmp', 'p2p', 'off'];
let cases = 0;
const viol = {finite: 0, eirp: 0, airtime: 0, capacity: 0, margin: 0, avail: 0,
              order: 0, cappedFlag: 0, pinch: 0};

for (const band of bands) {
  for (const width of BANDS[band].widths) {
    for (const reg of regs) {
      for (const site of ['off', 'mdrs', 'rolla']) {
        for (const baseH of [1, 3, 12]) {
          for (const ridgeH of site === 'off' ? [0, 8, 20] : [0]) {
            for (const cable of [0.4, 18]) {
              for (const tilt of [-45, 0, 33]) {
                for (const dist of [50, 300, 1050, 2500]) {
                  const p = P({band, width, reg, site, baseH, ridgeH, ridgeD: 500,
                               baseCable: cable, tilt, distance: dist,
                               baseTx: Math.min(DEFAULTS.baseTx, BANDS[band].txMax),
                               roverTx: Math.min(DEFAULTS.roverTx, BANDS[band].txMax),
                               heading: 111, aim: 40, baseE: -400, baseN: 250});
                  const r = solve(p, dist);
                  cases++;

                  if (allFinite(r).length) viol.finite++;
                  for (const k of ['up', 'down']) {
                    const d = r[k];
                    const cap = k === 'down'
                      ? allowedEirp(reg, band, r.baseGain)
                      : allowedEirp(reg, band, r.roverGain);
                    if (d.eirp > cap + 1e-6) viol.eirp++;
                    if (d.capped !== (d.eirpRaw > cap + 0.01)) viol.cappedFlag++;
                    if (d.capacity < -1e-9) viol.capacity++;
                    if (d.air < 0) viol.airtime++;
                    if (d.linkMargin < d.margin - 1e-9) viol.margin++;
                    if (d.linkAvail < -1e-9 || d.linkAvail > 1 + 1e-9) viol.avail++;
                    if (d.up && d.margin < -1e-9) viol.order++;
                    if (!d.up && d.mcs !== 0) viol.order++;
                  }
                  if (r.pinchAt < 0 || r.pinchAt > dist + 1e-6) viol.pinch++;
                }
              }
            }
          }
        }
      }
    }
  }
}
console.log(`   swept ${cases} configurations`);
check('no NaN or Infinity anywhere in the result tree', viol.finite === 0, `${viol.finite} cases`);
check('EIRP never exceeds the Part 15 ceiling', viol.eirp === 0, `${viol.eirp} cases`);
check('the "capped" flag matches the ceiling test', viol.cappedFlag === 0, `${viol.cappedFlag} cases`);
check('capacity is never negative', viol.capacity === 0, `${viol.capacity} cases`);
check('airtime is never negative', viol.airtime === 0, `${viol.airtime} cases`);
check('link margin always >= margin at the usual rate', viol.margin === 0, `${viol.margin} cases`);
check('link uptime stays inside [0, 1]', viol.avail === 0, `${viol.avail} cases`);
check('rate reporting is consistent with up/down', viol.order === 0, `${viol.order} cases`);
check('the Fresnel pinch point lies on the path', viol.pinch === 0, `${viol.pinch} cases`);

// --------------------------------------------------------- 5. edge cases

section('5. degenerate and boundary inputs');

const edges = [
  ['minimum distance', P({distance: 50})],
  ['sub-metre distance', P({distance: 1})],
  ['rover above the base', P({baseH: 1, roverH: 3})],
  ['identical heights', P({baseH: 1.2, roverH: 1.2})],
  ['ridge exactly at the rover', P({ridgeH: 10, ridgeD: 1000, distance: 1000})],
  ['ridge beyond the rover', P({ridgeH: 10, ridgeD: 2400, distance: 500})],
  ['ridge at the base', P({ridgeH: 10, ridgeD: 25, distance: 1000})],
  ['maximum everything', P({baseTx: 28, baseGain: 27, baseHBeam: 8, baseVBeam: 4, reg: 'off'})],
  ['minimum everything', P({baseTx: 5, roverTx: 5, baseGain: 3, roverGain: 2, baseCable: 20,
                            roverCable: 4, interference: 25, width: 10})],
  ['base pinned at map corner', P({site: 'mdrs', baseE: 2900, baseN: 2900, heading: 45})],
  ['rover driven off the map', P({site: 'rolla', baseE: 2900, baseN: 2900, heading: 45, distance: 2500})],
  ['heading 0 due north', P({site: 'mdrs', heading: 0})],
  ['heading 359', P({site: 'mdrs', heading: 359})],
  ['aim opposite the rover', P({site: 'mdrs', heading: 0, aim: 180})],
  ['extreme downtilt into dirt', P({downtilt: 15, baseVBeam: 4})],
  ['rover pitched fully over', P({tilt: -45, roverGain: 12})],
];
for (const [name, p] of edges) {
  const r = solve(p, p.distance);
  const bad = allFinite(r);
  check(name, bad.length === 0, bad.slice(0, 4).join(', '));
}

check('off-boresight angle always lands in [0, 180]',
  (() => {
    for (let h = 0; h < 360; h += 7)
      for (let a = 0; a < 360; a += 11) {
        const b = solve(P({site: 'mdrs', heading: h, aim: a}), 1000).bearingOff;
        if (!(b >= -1e-9 && b <= 180 + 1e-9)) return false;
      }
    return true;
  })());

near(solve(P({site: 'mdrs', heading: 0, aim: 350}), 1000).bearingOff, 10, 1e-6,
  'off-boresight wraps the short way round');
near(solve(P({site: 'mdrs', heading: 10, aim: 350}), 1000).bearingOff, 20, 1e-6,
  'off-boresight wraps across north');

// ------------------------------------------------------ 6. terrain wiring

section('6. terrain: orientation, sampling and diffraction');

for (const s of T.SITES) {
  const g = T.heightGrid(s.id);
  let lo = Infinity, hi = -Infinity;
  for (const v of g) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  // min/max span BOTH grids, because they drive the colour ramp and the ramp
  // must not restretch when the fine grid lands. So the coarse grid has to sit
  // inside them, not equal them — it can miss a peak the fine grid resolves.
  check(`${s.id}: decoded range sits inside the manifest range`,
    lo >= s.min - 0.11 && hi <= s.max + 0.11, `${lo}..${hi} vs ${s.min}..${s.max}`);
  check(`${s.id}: manifest range is not wildly wider than the coarse grid`,
    lo - s.min < 12 && s.max - hi < 12, `${lo}..${hi} vs ${s.min}..${s.max}`);
  check(`${s.id}: the bundled grid declares its own side length`, g.n === T.GRID);
  const half = T.SPAN_M / 2 - 1;
  const corners = [['NW', -half, half, g[0]], ['NE', half, half, g[T.GRID - 1]],
                   ['SW', -half, -half, g[(T.GRID - 1) * T.GRID]],
                   ['SE', half, -half, g[T.GRID * T.GRID - 1]]];
  check(`${s.id}: map orientation is not mirrored`,
    corners.every(([, e, n, v]) => Math.abs(T.sampleHeight(g, e, n) - v) < 1.0));
  check(`${s.id}: sampling outside the map is flat, not a cliff`,
    Math.abs(T.sampleHeight(g, 9999, 0) - T.sampleHeight(g, T.SPAN_M / 2, 0)) < 1e-6);
  near(T.distanceToEdge(0, 0, 0), T.SPAN_M / 2, 1, `${s.id}: edge distance due north`);
  near(T.distanceToEdge(0, 0, 45), (T.SPAN_M / 2) * Math.SQRT2, 1, `${s.id}: edge distance diagonal`);
}

// Imagery lives in static/ and is referenced by the manifest, so the two can
// drift apart if one is regenerated without the other.
for (const s of T.SITES) {
  check(`${s.id}: manifest names an imagery file`, typeof s.image === 'string' && s.image.length > 0);
  const abs = join(src, '..', 'static', s.image || '');
  let ok = false;
  let kb = 0;
  try { kb = statSync(abs).size / 1024; ok = kb > 8; } catch { ok = false; }
  check(`${s.id}: imagery file exists and is non-trivial`, ok, `${s.image} (${kb.toFixed(0)} KB)`);
  check(`${s.id}: imagery path is relative, so useBaseUrl can resolve it`,
    !s.image.startsWith('/') && !/^https?:/.test(s.image), s.image);
}

check('terrain mode finds both a clear and a blocked heading at MDRS',
  (() => {
    let clear = false, blocked = false;
    for (let h = 0; h < 360; h += 5) {
      const o = solve(P({site: 'mdrs', heading: h, distance: 1000}), 1000).obstruction;
      if (o < 0.05) clear = true;
      if (o > 25) blocked = true;
    }
    return clear && blocked;
  })(), 'the siting lesson has to be demonstrable');

check('raising the mast reduces diffraction over real terrain',
  (() => {
    const worst = (h) => {
      let mx = 0;
      for (let hd = 0; hd < 360; hd += 15)
        mx = Math.max(mx, solve(P({site: 'rolla', heading: hd, baseH: h}), 1000).obstruction);
      return mx;
    };
    return worst(12) <= worst(3) + 1e-9;
  })());

check('mast height above ground tracks real elevation',
  (() => {
    const r = solve(P({site: 'mdrs', baseE: 1200, baseN: -800, baseH: 3}), 1000);
    return Math.abs(r.baseZ - (r.groundBase + 3)) < 1e-9;
  })());

check('the synthetic world is untouched by the map code',
  (() => {
    const a = solve(P({site: 'off', ridgeH: 8, ridgeD: 450}), 1000);
    return a.profile === null && a.groundBase === 0 && a.obstruction > 10;
  })());

// ------------------------------------------------- 7. UI-state consistency

section('7. presets and UI state coupling');

for (const [name, p0] of Object.entries(PRESETS)) {
  const p = P(p0);
  const r = solve(p, p.distance);
  check(`preset "${name}" solves cleanly`, allFinite(r).length === 0);
  check(`preset "${name}" uses a width legal on its band`,
    BANDS[p.band].widths.includes(p.width), `${p.width} MHz on ${p.band}`);
  check(`preset "${name}" stays inside the radio's TX ceiling`,
    p.baseTx <= BANDS[p.band].txMax && p.roverTx <= BANDS[p.band].txMax);
}

check('defaults are internally legal',
  BANDS[DEFAULTS.band].widths.includes(DEFAULTS.width) &&
  DEFAULTS.baseTx <= BANDS[DEFAULTS.band].txMax &&
  DEFAULTS.roverTx <= BANDS[DEFAULTS.band].txMax);

check('2.4 GHz does not offer 80 MHz', !BANDS['2.4'].widths.includes(80));
// MikroTik publishes 29 dBm on 2.4 and 28 on 5, both at the bottom rate.
check('band switch would clamp TX', BANDS['5.8'].txMax === 28 && BANDS['2.4'].txMax === 29);

check('the antenna is derated correctly onto 2.4 GHz',
  (() => {
    const b = solve(P({band: '2.4', baseGain: 18, baseHBeam: 20, baseVBeam: 20}), 1000);
    const k = REF_MHZ / BANDS['2.4'].fMHz;
    // A panel is two dimensions of aperture, so it gives up 20log10(k) off the
    // gain it CLAIMS — not off the gain its beamwidths allow. The difference is
    // the part's own efficiency, and efficiency does not evaporate on a band
    // change: an antenna 2 dB under its own directivity stays 2 dB under it.
    const want = 18 - 20 * Math.log10(k);
    return Math.abs(b.hBase - 20 * k) < 0.01 && Math.abs(b.baseGain - want) < 0.02;
  })(), 'panel loses 20log10 of the wavelength ratio off its claimed gain');

check('a fake spec sheet is still caught by the beamwidth ceiling off-band',
  (() => {
    // Claimed 24 dBi from a 90x20 beam is 12.4 dB of fiction at 5.8. Off-band
    // the shift alone would carry that fiction along; the ceiling must bind.
    const b = solve(P({band: '2.4', baseGain: 24, baseHBeam: 90, baseVBeam: 20}), 1000);
    return Math.abs(b.baseGain - b.impliedGain) < 1e-9 && b.baseGain < 24 - 7;
  })());

check('base and rover score the same omni identically',
  (() => {
    // The same 6.7 dBi element, once in each slot, on a band it was not quoted
    // at. A base omni used to keep every dB of it, because its stand-in 120 deg
    // azimuth put the directivity ceiling far out of reach.
    const drop = 10 * Math.log10(REF_MHZ / BANDS['2.4'].fMHz);
    const b = solve(P({band: '2.4', baseKind: 'omni', baseGain: 6.7, baseHBeam: 120,
                       baseVBeam: omniVBeam(6.7), roverGain: 6.7}), 1000);
    return Math.abs(b.baseGain - (6.7 - drop)) < 0.02 &&
           Math.abs(b.baseGain - b.roverGain) < 0.02;
  })(), 'a one-dimensional aperture loses 10log10 whichever end of the link it is on');

check('the omni is derated by half that, being a one-dimensional aperture',
  (() => {
    const b = solve(P({band: '2.4', roverGain: 6.7}), 1000);
    return Math.abs(b.roverGain - (6.7 - 10 * Math.log10(REF_MHZ / BANDS['2.4'].fMHz))) < 0.02;
  })());

check('a fake spec sheet is derated to what the beamwidth allows',
  (() => {
    const r = solve(P({baseGain: 24, baseHBeam: 90, baseVBeam: 20}), 1000);
    return Math.abs(r.baseGain - dirFromBeamwidth(90, 20)) < 0.02 && r.baseGain < 24;
  })());

// ------------------------------------------------------------ 8. airtime

section('8. half-duplex airtime accounting');

check('airtime is the sum of the two demands',
  (() => {
    for (const d of [300, 1000, 2000]) {
      const r = solve(P(), d);
      if (Math.abs(r.airtime - (r.down.air + r.up.air)) > 1e-9) return false;
    }
    return true;
  })());

check('airtime equals demand divided by capacity',
  (() => {
    const r = solve(P(), 1000);
    return Math.abs(r.up.air - VIDEO_FLOOR / r.up.capacity) < 1e-9 &&
           Math.abs(r.down.air - CONTROL_FLOOR / r.down.capacity) < 1e-9;
  })());

check('a link that cannot fit the mission is not marked as fitting',
  (() => {
    const r = solve(P({baseCable: 18, ridgeH: 8, ridgeD: 450}), 1000);
    // Fade averaging credits the fallback rungs, so airtime alone no longer
    // has to exceed 100% — the link being down half the time is what kills it.
    return !r.fits && !r.up.up && r.up.linkAvail < 0.5;
  })());

check('"fits" also demands the link is actually there to carry it',
  (() => {
    // A link that carries 8 Mbps whenever it is up, but is up half the drive,
    // must not read as a working mission.
    const r = solve(P({baseCable: 18, tilt: 22, roverGain: 9}), 1000);
    if (r.airtime > 1) return false;          // airtime alone would have passed it
    return !r.fits && r.linkAvail < 0.9;
  })());

check('fits implies every component condition',
  (() => {
    for (const cable of [0.4, 6, 12, 18])
      for (const d of [200, 1000, 2500, 4000]) {
        const r = solve(P({baseCable: cable}), d);
        if (r.fits && !(r.up.up && r.down.up && r.airtime <= 1 && r.linkAvail >= 0.9)) return false;
      }
    return true;
  })());

check('a direction that is down reports a matching usual rate and uptime',
  (() => {
    for (const cable of [16, 18, 20]) {
      const d = solve(P({baseCable: cable, ridgeH: 8, ridgeD: 450}), 1000).up;
      if (!d.up && (d.mcs !== 0 || d.hold !== d.linkAvail)) return false;
      if (!d.up && d.linkAvail >= 0.5) return false;
    }
    return true;
  })());

check('sentinels are infinite only when they should be',
  (() => {
    const off = solve(P({reg: 'off'}), 1000);
    const on = solve(P({reg: 'ptmp'}), 1000);
    if (Number.isFinite(off.capBase) || !Number.isFinite(on.capBase)) return false;
    const alive = solve(P(), 1000);
    if (!Number.isFinite(alive.airtime) || !Number.isFinite(alive.up.air)) return false;
    const dead = solve(P({baseCable: 20, interference: 25, baseTx: 5, roverTx: 5,
                          baseGain: 3, roverGain: 2, roverCable: 4}), 2500);
    return dead.up.capacity === 0 && !Number.isFinite(dead.up.air);
  })());

check('"fits" requires both directions up',
  (() => {
    for (const d of [100, 1000, 3000, 5000]) {
      const r = solve(P({baseCable: 14, interference: 18}), d);
      if (r.fits && !(r.up.up && r.down.up)) return false;
    }
    return true;
  })());

check('the ACK timeout penalty only bites past 300 m',
  (() => {
    const near300 = solve(P({ackSet: false, distance: 300}), 300);
    const ref = solve(P({ackSet: true, distance: 300}), 300);
    const far = solve(P({ackSet: false, distance: 2000}), 2000);
    const farRef = solve(P({ackSet: true, distance: 2000}), 2000);
    return Math.abs(near300.up.capacity - ref.up.capacity) < 1e-9 &&
           far.up.capacity < farRef.up.capacity * 0.8;
  })());


// ------------------------------------------------------- 9. radio configs

section('9. user-defined radios and antennas');

check('an unset radio is the NetMetal ax, bit for bit',
  (() => {
    for (const d of [200, 1000, 2400]) {
      const a = solve(P(), d);
      const b = solve(P({baseRadio: DEFAULT_RADIO, roverRadio: DEFAULT_RADIO}), d);
      for (const k of ['up', 'down'])
        if (Math.abs(a[k].capacity - b[k].capacity) > 1e-9 ||
            Math.abs(a[k].linkMargin - b[k].linkMargin) > 1e-9) return false;
    }
    return true;
  })(), 'the radio layer must not move the doc page by a single dB');

check('the default radio carries the datasheet sensitivity curve on both bands',
  (() => {
    const r = normalizeRadio(DEFAULT_RADIO);
    // MikroTik prints -96 at the bottom and -67 at MCS11 on 5 GHz, and the same
    // -67 top rung on 2.4 with a slightly better floor. The 2.4 curve is
    // therefore very slightly shallower, not the flat -1 dB offset once assumed.
    const b24 = r.bands['2.4'].sens;
    return r.bands['5.8'].sens.every((v, i) => Math.abs(v - SENS20[i]) < 1e-9) &&
           Math.abs(b24[0] + 97) < 1e-9 &&
           Math.abs(b24[b24.length - 1] + 67) < 1e-9 &&
           b24.every((v, i) => i === 0 || v >= b24[i - 1] - 1e-9);
  })());

// --- the installation, not just the radio

check('two chains only carry two streams if they are cross-polarised',
  (() => {
    const xpol = solve(P({roverXpol: true}), 1000);
    const copol = solve(P({roverXpol: false}), 1000);
    return xpol.streams === 2 && copol.streams === 1 &&
           copol.streamLimit === 'polarization' && xpol.streamLimit === null;
  })(), 'two vertical omnis on a rover mast see one channel, not two');

check('a single-port antenna caps the link at one stream',
  (() => {
    const r = solve(P({roverChains: 1}), 1000);
    return r.streams === 1 && r.chainCap === 1 && r.streamLimit === 'chains';
  })());

check('the installation cannot invent streams the radio does not have',
  (() => {
    const oneStream = {...DEFAULT_RADIO, id: 'x1', streams: 1};
    const r = solve(P({baseRadio: oneStream, baseChains: 4, roverChains: 4}), 1000);
    return r.streams === 1 && r.streamLimit === null;
  })());

check('halving the streams halves the PHY, not the margin',
  (() => {
    const two = solve(P(), 1000);
    const one = solve(P({roverXpol: false}), 1000);
    return Math.abs(one.up.linkMargin - two.up.linkMargin) < 1e-9 &&
           Math.abs(one.up.rungs[5].phy * 2 - two.up.rungs[5].phy) < 1e-9;
  })(), 'polarization costs you rate, not signal');

// --- the wire behind the radio

check('a Fast Ethernet port caps what the air can deliver',
  (() => {
    const m5 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m5');
    const r = solve(reconcileLink(P({baseRadio: m5, roverRadio: m5, band: '5.8', width: 40})), 200);
    // 100 Mbps of port, minus framing, is the ceiling however good the link is.
    return r.ethCap === 94 && r.up.capacity <= 94 + 1e-9 && r.down.capacity <= 94 + 1e-9;
  })());

check('the slower of the two ports is the one that binds',
  (() => {
    const m5 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m5');
    const mixed = solve(reconcileLink(P({baseRadio: m5, band: '5.8'})), 200);
    return mixed.ethCap === 94;
  })());

check('a gigabit pair is never held back by its port at these rates',
  (() => {
    const r = solve(P({width: 80}), 100);
    return !r.ethBound && r.up.capacity < r.ethCap;
  })());

// --- what the rules allow, not just what the radio tunes

check('900 MHz offers the 8 MHz channel the rules require',
  (() => {
    const m9 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m900');
    const lim = linkLimits(m9, m9);
    const w = lim.widthsFor('0.9');
    return w.includes(8) && WIDTHS[8].rate === 0.4 &&
           Math.abs(WIDTHS[8].sens - 10 * Math.log10(8 / 20)) < 0.01;
  })());

check('narrowing to 8 MHz buys noise floor and costs rate',
  (() => {
    const m9 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m900');
    const at = (w) => solve(P({baseRadio: m9, roverRadio: m9, band: '0.9', width: w,
                               baseRefMHz: BANDS['0.9'].fMHz, roverRefMHz: BANDS['0.9'].fMHz}), 1000);
    const a = at(8);
    const b = at(20);
    return a.up.linkMargin > b.up.linkMargin && a.up.rungs[0].phy < b.up.rungs[0].phy;
  })());

check('sensCurve honours both anchors and keeps the curve monotonic',
  (() => {
    const c = sensCurve('ax', -100, -60);
    if (Math.abs(c[0] + 100) > 1e-9 || Math.abs(c[c.length - 1] + 60) > 1e-9) return false;
    return c.every((v, i) => i === 0 || v >= c[i - 1] - 1e-9);
  })());

check('every built-in radio solves cleanly against every other one',
  (() => {
    for (const a of BUILTIN_RADIOS) {
      for (const b of BUILTIN_RADIOS) {
        const lim = linkLimits(a, b);
        for (const band of lim.bands) {
          const p = reconcileLink(P({baseRadio: a, roverRadio: b, band}));
          const r = solve(p, 1000);
          if (allFinite(r).length) return false;
          if (!r.bandOk) return false;
        }
      }
    }
    return true;
  })());

check('a band neither radio has leaves the link dead but finite',
  (() => {
    const m2 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m2'); // 2.4 only
    const r = solve(P({band: '5.8', baseRadio: m2, roverRadio: m2}), 1000);
    return !r.bandOk && allFinite(r).length === 0 && !r.up.up && !r.down.up &&
           r.up.capacity === 0;
  })());

check('the pair runs at the weaker end: streams and rate ladder',
  (() => {
    const oneStream = {...DEFAULT_RADIO, id: 'x1', streams: 1};
    const r = solve(P({baseRadio: oneStream}), 1000);
    const ref = solve(P(), 1000);
    return r.streams === 1 && Math.abs(r.up.phy - ref.up.phy / 2) < 1e-9;
  })());

check('an 802.11n end truncates the ladder for both directions',
  (() => {
    const m2 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m2');
    const r = solve(P({band: '2.4', baseRadio: m2}), 300);
    return r.maxMcs === 7 && r.up.rungs.length === 8 && r.down.rungs.length === 8;
  })());

check('sensitivity follows the receiver, not the transmitter',
  (() => {
    // Make the base deaf. Only the rover-to-base direction should suffer.
    const deaf = {...DEFAULT_RADIO, id: 'deaf',
      bands: {...DEFAULT_RADIO.bands, '5.8': {...DEFAULT_RADIO.bands['5.8'], sens0: -76, sensTop: -47}}};
    const r = solve(P({baseRadio: deaf}), 1000);
    const ref = solve(P(), 1000);
    return Math.abs(r.up.linkMargin - (ref.up.linkMargin - 20)) < 1e-6 &&
           Math.abs(r.down.linkMargin - ref.down.linkMargin) < 1e-9;
  })());

check('a lower TX ceiling binds even with the slider pushed past it',
  (() => {
    const weak = {...DEFAULT_RADIO, id: 'weak',
      bands: {...DEFAULT_RADIO.bands, '5.8': {...DEFAULT_RADIO.bands['5.8'], txMax: 18}}};
    const r = solve(P({reg: 'off', baseTx: 28, baseRadio: weak}), 1000);
    return r.down.tx <= 18 + 1e-9 && r.down.rungs.every((rg) => rg.tx <= 18 + 1e-9);
  })());

check('reconcileLink drags an illegal band, width and TX back into range',
  (() => {
    const m2 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m2'); // 2.4, no 80 MHz, 28 dBm
    const p = reconcileLink(P({band: '5.8', width: 80, baseTx: 28, roverTx: 28,
                               baseRadio: m2, roverRadio: m2}));
    const lim = linkLimits(p.baseRadio, p.roverRadio);
    return p.band === '2.4' && lim.widthsFor(p.band).includes(p.width) &&
           p.baseTx <= 28 && p.roverTx <= 30;
  })());

check('normalizing junk never produces a radio that breaks solve',
  (() => {
    const junk = [null, {}, {family: 'nonsense', streams: 99, bands: {}},
                  {bands: {'5.8': {txMax: 'x', widths: [7], sens0: -20, sensTop: -200}}}];
    for (const j of junk) {
      const spec = normalizeRadioSpec(j);
      const r = solve(P({baseRadio: spec, roverRadio: spec}), 1000);
      if (allFinite(r).length) return false;
    }
    return true;
  })());

check('an antenna round-trips through a slot without drifting',
  (() => {
    for (const a of BUILTIN_ANTENNAS) {
      const ant = normalizeAntenna(a);
      const p = {...DEFAULTS, ...applyBaseAntenna(ant)};
      if (!baseMatches(p, ant)) return false;
      const q = {...DEFAULTS, ...applyRoverAntenna(ant)};
      if (!roverMatches(q, ant)) return false;
    }
    return true;
  })());

check('a slot edit is detected as drift, and re-saving clears it',
  (() => {
    const ant = normalizeAntenna(BUILTIN_ANTENNAS[0]);
    const p = {...DEFAULTS, ...applyBaseAntenna(ant), baseGain: 21};
    if (baseMatches(p, ant)) return false;
    const saved = antennaFromBase(p, 'edited');
    return baseMatches(p, saved) && Math.abs(saved.gain - 21) < 1e-9;
  })());

check('every built-in antenna survives normalisation unchanged',
  (() => BUILTIN_ANTENNAS.every((a) => {
    const n = normalizeAntenna(a);
    return n.name === a.name && Math.abs(n.gain - a.gain) < 1e-9 &&
           (a.kind === 'omni' ? n.hBeam === 360 : n.hBeam === a.hBeam);
  }))());

check('export then import returns the same gear, without clobbering ids',
  (() => {
    const mine = {antennas: [normalizeAntenna({name: 'mine', gain: 14, hBeam: 40, vBeam: 40})],
                  radios: [], setups: []};
    const merged = importGear(exportGear(mine), mine);
    return merged.antennas.length === 2 && merged.antennas[0].id !== merged.antennas[1].id;
  })());

check('sweepRange agrees with solving each distance by hand',
  (() => {
    const p = P({site: 'off'});
    const s = sweepRange(p);
    return s.rows.every((row) => Math.abs(solve(p, row.d).up.capacity - row.up) < 1e-9);
  })());

// --------------------------------------- 10. 900 MHz, yagis and reference bands

section('10. 900 MHz, yagis and reference bands');

near(BANDS['0.9'].fMHz, 915, 1e-9, '900 MHz sits mid-ISM at 915');
check('900 MHz has no 40 MHz channel to tune',
  !BANDS['0.9'].widths.includes(40) && BANDS['0.9'].widths.includes(5),
  '902-928 is 26 MHz wide in total');
near(WIDTHS[5].rate, 0.25, 1e-9, '5 MHz carries a quarter of the 20 MHz rate');
near(WIDTHS[5].sens, -6.02, 0.03, '5 MHz buys 6 dB of noise floor');

// The point-to-point relief in 15.247(b)(3) names 2.4 and 5.8 and stops there.
near(allowedEirp('ptmp', '0.9', 24), 36, 1e-9, 'Part 15 PtMP on 900 MHz pins EIRP at 36');
near(allowedEirp('p2p', '0.9', 24), 36, 1e-9, '900 MHz gets no point-to-point relief');
check('900 MHz p2p and ptmp agree at every gain',
  [...Array(31)].every((_, g) =>
    Math.abs(allowedEirp('p2p', '0.9', g) - allowedEirp('ptmp', '0.9', g)) < 1e-9));

// An aperture loses two dimensions off its own band, an end-fire array one.
const bandShift = (kind, band) => {
  const at = solve(P({band, baseKind: kind, baseRefMHz: REF_MHZ,
                      baseGain: 30, baseHBeam: 20, baseVBeam: 20}), 1000);
  return at.baseGain;
};
check('a panel gives up 20log10 of the wavelength ratio on 2.4',
  Math.abs((bandShift('sector', '5.8') - bandShift('sector', '2.4'))
           - 20 * Math.log10(REF_MHZ / BANDS['2.4'].fMHz)) < 0.02);
check('a yagi gives up only 10log10 of the same ratio',
  Math.abs((bandShift('yagi', '5.8') - bandShift('yagi', '2.4'))
           - 10 * Math.log10(REF_MHZ / BANDS['2.4'].fMHz)) < 0.02);
check('a yagi beam broadens by the square root, keeping 41253/(H x V) true',
  (() => {
    const k = REF_MHZ / BANDS['2.4'].fMHz;
    const r = solve(P({band: '2.4', baseKind: 'yagi', baseHBeam: 20, baseVBeam: 20}), 1000);
    return Math.abs(r.hBase - 20 * Math.sqrt(k)) < 0.02 &&
           Math.abs(r.vBase - 20 * Math.sqrt(k)) < 0.02 &&
           Math.abs(r.impliedGain - dirFromBeamwidth(r.hBase, r.vBase)) < 1e-9;
  })());
check('an omni on the mast stays round in azimuth and pays it all in elevation',
  (() => {
    const k = REF_MHZ / BANDS['2.4'].fMHz;
    const r = solve(P({band: '2.4', baseKind: 'omni', baseHBeam: 120, baseVBeam: 20}), 1000);
    return Math.abs(r.hBase - 120) < 1e-9 && Math.abs(r.vBase - 20 * k) < 0.02;
  })());

check('a part quoted at the band it is running on is not scaled at all',
  (() => {
    const r = solve(P({band: '0.9', baseRefMHz: BANDS['0.9'].fMHz, baseKind: 'yagi',
                       baseGain: 13, baseHBeam: 44, baseVBeam: 47,
                       roverRefMHz: BANDS['0.9'].fMHz, roverGain: 3}), 1000);
    return Math.abs(r.hBase - 44) < 1e-9 && Math.abs(r.vBase - 47) < 1e-9 &&
           Math.abs(r.baseGain - 13) < 0.02 && Math.abs(r.roverGain - 3) < 1e-9;
  })(), 'the whole point of a reference band');

check('a 900 MHz yagi read as a 5.8 GHz part would be a different antenna',
  (() => {
    const asIs = solve(P({band: '0.9', baseRefMHz: BANDS['0.9'].fMHz, baseKind: 'yagi',
                          baseGain: 13, baseHBeam: 44, baseVBeam: 47}), 1000);
    const mislabelled = solve(P({band: '0.9', baseKind: 'yagi',
                                 baseGain: 13, baseHBeam: 44, baseVBeam: 47}), 1000);
    return asIs.baseGain - mislabelled.baseGain > 3;
  })());

check('absent kind and reference read as the 5.8 GHz panel they always were',
  (() => {
    const {baseKind, baseRefMHz, roverRefMHz, ...bare} = P({band: '2.4'});
    const a = solve(bare, 1000);
    const b = solve(P({band: '2.4'}), 1000);
    return Math.abs(a.baseGain - b.baseGain) < 1e-12 &&
           Math.abs(a.roverGain - b.roverGain) < 1e-12 &&
           Math.abs(a.up.capacity - b.up.capacity) < 1e-12;
  })(), 'every setup saved before parts carried a band must still solve the same');

check('the gear layer hands the model the kind and the band it was quoted at',
  (() => {
    const yagi = BUILTIN_ANTENNAS.find((a) => a.id === 'yagi-900-13');
    const applied = applyBaseAntenna(yagi);
    return applied.baseKind === 'yagi' && applied.baseRefMHz === BANDS['0.9'].fMHz &&
           roverMatches({...applyRoverAntenna(yagi)}, yagi);
  })());

check('a saved part round-trips its kind and band through the sliders',
  (() => {
    const yagi = normalizeAntenna(BUILTIN_ANTENNAS.find((a) => a.id === 'yagi-900-13'));
    const back = antennaFromBase({...DEFAULTS, ...applyBaseAntenna(yagi)}, 'copy');
    return back.kind === 'yagi' && back.ref === '0.9' &&
           Math.abs(back.gain - yagi.gain) < 1e-9 && back.hBeam === yagi.hBeam;
  })());

check('every built-in antenna survives normalisation with its kind intact',
  BUILTIN_ANTENNAS.every((a) => {
    const n = normalizeAntenna(a);
    return n.kind === (a.kind || 'sector') && n.ref === (a.ref || '5.8');
  }));

check('a 900 MHz pair solves cleanly end to end',
  (() => {
    const m900 = BUILTIN_RADIOS.find((r) => r.id === 'rocket-m900');
    const lim = linkLimits(m900, m900);
    if (lim.bands.length !== 1 || lim.bands[0] !== '0.9') return false;
    const yagi = BUILTIN_ANTENNAS.find((a) => a.id === 'yagi-900-13');
    const whip = BUILTIN_ANTENNAS.find((a) => a.id === 'rover-whip-900');
    const p = reconcileLink(P({baseRadio: m900, roverRadio: m900, band: '0.9',
                               ...applyBaseAntenna(yagi), ...applyRoverAntenna(whip)}));
    const r = solve(p, 1000);
    return !allFinite(r).length && r.bandOk && BANDS['0.9'].widths.includes(p.width) &&
           r.up.capacity > 0 && r.down.capacity > 0;
  })());

check('900 MHz beats 5.8 GHz through a ridge, which is why anyone puts up with it',
  (() => {
    const ridge = {site: 'off', ridgeH: 12, ridgeD: 500, baseKind: 'yagi'};
    const low = solve(P({...ridge, band: '0.9', baseRefMHz: BANDS['0.9'].fMHz,
                         roverRefMHz: BANDS['0.9'].fMHz}), 1000);
    const high = solve(P({...ridge, band: '5.8'}), 1000);
    return low.obstruction < high.obstruction;
  })(), 'longer wavelength diffracts over an edge more cheaply');

// ------------------------------------------------------------------ done

console.log(`\n${'─'.repeat(60)}`);
if (fails.length === 0) {
  console.log(`ALL ${pass} CHECKS PASSED`);
} else {
  console.log(`${pass} passed, ${fails.length} FAILED:\n`);
  for (const f of fails) console.log(`  • ${f}`);
  process.exitCode = 1;
}
