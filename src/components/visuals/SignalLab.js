import React, {useMemo, useState} from 'react';
import styles from './SignalLab.module.css';

// A hands-on RF link lab for the NetMetal ax upgrade. Drag TX power, antenna
// gain, beamwidth, cable loss, channel width, terrain and distance, and watch
// what each one actually does to the link.
//
// The physics is real (Friis, ITU-R P.526 knife-edge, first Fresnel zone, the
// FCC Part 15 EIRP ceiling, and the NetMetal ax MCS/sensitivity table straight
// off the datasheet). The rate-control and goodput layer is a simplification,
// so treat the numbers as teaching values, not a throughput prediction.
// SSR-safe: pure computation and inline SVG, no browser APIs.

// ---------------------------------------------------------------- constants

const BANDS = {
  '2.4': {label: '2.4 GHz', fMHz: 2437, sensAdj: -1},
  '5.8': {label: '5.8 GHz', fMHz: 5800, sensAdj: 0},
};

// 802.11ax, 2 spatial streams, 20 MHz, 0.8 us guard interval. Per-stream Mbps.
// Sanity check: MCS11 x 2 streams x 2.00 (40 MHz) = 574 Mbps, and x 8.38
// (160 MHz) = 2404 Mbps, which is exactly what MikroTik prints on the datasheet.
const PHY20 = [8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86.0, 103.2, 114.7, 129.0, 143.4];

// Datasheet receive sensitivity, 5 GHz, 20 MHz, dBm. Anchored on the three
// numbers MikroTik publishes: -96 at MCS0, -70 at MCS9, -67 at MCS11.
const SENS20 = [-96, -94, -91, -89, -85, -81, -80, -78, -74, -70, -69, -67];

// The radio backs its own power off as the constellation gets denser: the
// NetMetal ax does 28 dBm at MCS0 and only 20 dBm at MCS11.
const TX_BACKOFF = [0, 0, 1, 1, 2, 3, 4, 4, 6, 7, 7, 8];

const WIDTHS = {
  10: {rate: 0.5, sens: -3.0},
  20: {rate: 1.0, sens: 0.0},
  40: {rate: 2.0, sens: 3.0},
  80: {rate: 4.19, sens: 6.0},
};

const STREAMS = 2;
const MAC_EFFICIENCY = 0.55; // 802.11ax goodput as a fraction of PHY rate
const VIDEO_FLOOR = 8; // Mbps of H.265 the mission actually needs
const CONDUCTED_MAX = 30; // dBm, the 1 W Part 15 conducted ceiling

const OK = '#4caf50';
const WARN = '#e5a73c';
const BAD = '#e06c75';

// ---------------------------------------------------------------- RF math

const log10 = (x) => Math.log(x) / Math.LN10;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dbToLin = (db) => Math.pow(10, db / 10);

// Friis, in the engineer's form. d in metres, f in MHz.
const fspl = (dM, fMHz) => 20 * log10(Math.max(dM, 1) / 1000) + 20 * log10(fMHz) + 32.44;

const lambdaM = (fMHz) => 299.792458 / fMHz;

// First Fresnel zone radius, metres, at a point d1 along a path of length D.
const fresnel = (d1, D, fMHz) => {
  const d2 = D - d1;
  if (d1 <= 0 || d2 <= 0) return 0;
  return Math.sqrt((lambdaM(fMHz) * d1 * d2) / D);
};

// Directivity from beamwidth. The number every antenna spec sheet has to obey.
const dirFromBeamwidth = (hDeg, vDeg) => 10 * log10(41253 / (hDeg * vDeg));

// Elevation beamwidth of a vertical omni, which is 360 degrees in azimuth.
const omniVBeam = (gainDbi) => clamp(41253 / (dbToLin(gainDbi) * 360), 3, 120);

// Main-lobe rolloff. -3 dB at half the 3 dB beamwidth, floored at the sidelobes.
const rolloff = (offDeg, bwDeg, floorDb) =>
  Math.max(-floorDb, -12 * Math.pow(Math.abs(offDeg) / bwDeg, 2));

// ITU-R P.526 single knife-edge diffraction. h is obstruction height above the
// line of sight, so positive h means the ridge is actually in the way.
const knifeEdge = (h, d1, d2, fMHz) => {
  if (d1 <= 0 || d2 <= 0) return 0;
  const v = h * Math.sqrt((2 * (d1 + d2)) / (lambdaM(fMHz) * d1 * d2));
  if (v <= -0.78) return 0;
  return 6.9 + 20 * log10(Math.sqrt(Math.pow(v - 0.1, 2) + 1) + v - 0.1);
};

// The Part 15 ceiling, expressed as the most EIRP you may legally radiate.
// Point-to-multipoint: 1 dB of conducted power back for every 1 dB of gain
// past 6 dBi, which pins EIRP at 36 dBm no matter how big the antenna gets.
// Point-to-point: 5.8 GHz gets the gain for free, 2.4 GHz gives back 1 dB per 3.
function allowedEirp(mode, band, gainDbi) {
  if (mode === 'off') return Infinity;
  if (mode === 'ptmp') return CONDUCTED_MAX + Math.min(gainDbi, 6);
  if (band === '5.8') return CONDUCTED_MAX + gainDbi;
  return CONDUCTED_MAX + gainDbi - Math.max(0, gainDbi - 6) / 3;
}

// ---------------------------------------------------------------- the model

function solve(p, distance) {
  const band = BANDS[p.band];
  const w = WIDTHS[p.width];
  const D = distance;

  // --- geometry, all in metres
  const dh = p.roverH - p.baseH;
  const elevDeg = (Math.atan2(dh, D) * 180) / Math.PI;

  // Terrain. The ridge sits at a fixed fraction of the path.
  const dNear = D * p.ridgeAt;
  const dFar = D - dNear;
  const losAtRidge = p.baseH + dh * p.ridgeAt;
  const hAboveLos = p.ridgeH - losAtRidge;
  const f1AtRidge = fresnel(dNear, D, band.fMHz);
  const clearance = f1AtRidge > 0 ? -hAboveLos / f1AtRidge : 9;
  const obstruction = p.ridgeH > 0 ? knifeEdge(hAboveLos, dNear, dFar, band.fMHz) : 0;

  const pathLoss = fspl(D, band.fMHz) + obstruction;

  // --- antenna gain actually pointed at the other end
  const vBase = p.baseVBeam;
  // What the two beamwidths say the antenna can possibly do. Claimed gain above
  // this is fiction; well below it is either honest loss or a shy vendor.
  // Directivity is a hard ceiling, so a listing claiming more than its own
  // beamwidth allows gets derated to what the geometry can actually produce.
  const impliedGain = dirFromBeamwidth(p.baseHBeam, p.baseVBeam);
  const baseGain = Math.min(p.baseGain, impliedGain);
  const baseAz = rolloff(p.bearing, p.baseHBeam, 25);
  const baseEl = rolloff(elevDeg + p.downtilt, vBase, 25);
  const baseEff = baseGain + baseAz + baseEl;

  const vRover = omniVBeam(p.roverGain);
  const roverOff = Math.abs(p.tilt) + Math.abs(elevDeg);
  const roverEff = p.roverGain + rolloff(roverOff, vRover, 20);

  // --- regulatory ceiling, computed on peak gain the way the FCC measures it
  const capBase = allowedEirp(p.reg, p.band, baseGain);
  const capRover = allowedEirp(p.reg, p.band, p.roverGain);

  const noiseAdj = w.sens + p.interference + band.sensAdj;
  const sensOf = (mcs) => SENS20[mcs] + noiseAdj;

  // One direction. Walk the rate ladder down from MCS11 and take the first
  // rate whose sensitivity the received power clears, remembering that the
  // radio's own TX power drops as the rate climbs.
  function direction(txMax, cableTx, gainPeakTx, gainEffTx, cap, gainEffRx, cableRx) {
    for (let mcs = 11; mcs >= 0; mcs--) {
      const tx = Math.min(txMax, 28 - TX_BACKOFF[mcs]);
      const eirpRaw = tx - cableTx + gainPeakTx;
      const eirp = Math.min(eirpRaw, cap);
      const rx = eirp - (gainPeakTx - gainEffTx) - pathLoss + gainEffRx - cableRx;
      if (rx >= sensOf(mcs)) {
        return {
          up: true, mcs, tx, eirpRaw, eirp,
          capped: eirpRaw > cap + 0.01,
          rx, sens: sensOf(mcs), margin: rx - sensOf(mcs),
          phy: PHY20[mcs] * STREAMS * w.rate,
        };
      }
    }
    // Nothing closed. Report the numbers at the bottom rung so the panel can
    // still show how far short you are.
    const tx = Math.min(txMax, 28);
    const eirp = Math.min(tx - cableTx + gainPeakTx, cap);
    const rx = eirp - (gainPeakTx - gainEffTx) - pathLoss + gainEffRx - cableRx;
    return {
      up: false, mcs: -1, tx, eirpRaw: tx - cableTx + gainPeakTx, eirp,
      capped: tx - cableTx + gainPeakTx > cap + 0.01,
      rx, sens: sensOf(0), margin: rx - sensOf(0), phy: 0,
    };
  }

  const down = direction(p.baseTx, p.baseCable, baseGain, baseEff, capBase, roverEff, p.roverCable);
  const up = direction(p.roverTx, p.roverCable, p.roverGain, roverEff, capRover, baseEff, p.baseCable);

  // Default Wi-Fi ACK timing assumes an indoor room. Leave it unset on a
  // kilometre link and the retries eat the airtime.
  const ackFactor = p.ackSet ? 1 : D <= 300 ? 1 : Math.max(0.1, 1 - (D - 300) / 1200);
  const goodput = (dir) => dir.phy * MAC_EFFICIENCY * ackFactor;

  return {
    D, elevDeg, vBase, vRover, impliedGain, baseGain, baseAz, baseEl, baseEff, roverEff,
    capBase, capRover, obstruction, clearance, f1AtRidge, hAboveLos, dNear, dFar,
    fsplDb: fspl(D, band.fMHz), pathLoss, ackFactor,
    f1Mid: fresnel(D / 2, D, band.fMHz),
    lateral: D * Math.tan((p.baseHBeam / 2) * (Math.PI / 180)),
    down: {...down, goodput: goodput(down)},
    up: {...up, goodput: goodput(up)},
  };
}

const DEFAULTS = {
  band: '5.8',
  width: 20,
  distance: 1000,
  baseH: 3,
  roverH: 1.2,
  ridgeH: 0,
  ridgeAt: 0.5,
  baseTx: 25,
  baseGain: 18,
  baseHBeam: 20,
  baseVBeam: 20,
  baseCable: 0.4,
  downtilt: 0,
  bearing: 0,
  roverTx: 25,
  roverGain: 6.7,
  roverCable: 0.3,
  tilt: 0,
  reg: 'ptmp',
  interference: 0,
  ackSet: true,
};

const PRESETS = {
  'NetMetal ax + panel, 1 km clear': {},
  'Cheap ALFA pair instead': {baseGain: 10, baseHBeam: 66, baseVBeam: 16},
  'The 25 m coax mistake': {baseCable: 18},
  'Rover pitched on a slope': {tilt: 22, roverGain: 9},
  'Behind a ridge': {ridgeH: 8, ridgeAt: 0.45},
  'Wrong downtilt bracket': {baseGain: 15, baseHBeam: 90, baseVBeam: 7, downtilt: 10},
  'Antenna with a fake spec sheet': {baseGain: 24, baseHBeam: 90, baseVBeam: 20},
  'Competition day interference': {interference: 14},
  'ACK timeout left at default': {ackSet: false},
};

// ---------------------------------------------------------------- widgets

function Slider({label, value, min, max, step, unit, onChange, hint, disabled}) {
  return (
    <label className={`${styles.ctl} ${disabled ? styles.ctlOff : ''}`}>
      <span className={styles.ctlTop}>
        <span>{label}</span>
        <b>{value}{unit}</b>
      </span>
      <input
        type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        onChange={(e) => onChange(+e.target.value)}
      />
      {hint && <span className={styles.ctlHint}>{hint}</span>}
    </label>
  );
}

function Pills({label, value, options, onChange}) {
  return (
    <div className={styles.ctl}>
      <span className={styles.ctlTop}><span>{label}</span></span>
      <div className={styles.pills}>
        {options.map(([v, txt]) => (
          <button
            key={v}
            className={`${styles.pill} ${value === v ? styles.pillOn : ''}`}
            onClick={() => onChange(v)}
          >
            {txt}
          </button>
        ))}
      </div>
    </div>
  );
}

const d1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const d0 = (x) => Math.round(x);

// D ≈ 41253 / (H° × V°). If the claimed gain doesn't agree with the claimed
// beamwidth, one of the two numbers is fiction. This is the cheapest way to
// catch a marketplace listing that has been sexed up by 5 dB.
function SpecCheck({claimed, implied}) {
  const gap = claimed - implied;
  if (gap > 1) {
    return (
      <b style={{color: BAD}}>
        beamwidth only allows {d1(implied)} dBi, so the lab is using that instead
      </b>
    );
  }
  if (gap < -4) {
    return <span>beamwidth allows {d1(implied)} dBi, so this is conservative or lossy</span>;
  }
  return <span>beamwidth implies {d1(implied)} dBi, consistent</span>;
}

// ---------------------------------------------------------------- side view

function SideView({p, r}) {
  const W = 900;
  const H = 260;
  const padL = 60;
  const padR = 40;
  const ground = H - 42;
  const span = W - padL - padR;

  const xOf = (frac) => padL + frac * span;
  // Vertical scale is heavily exaggerated. 3 m of mast over 1 km of desert is
  // invisible at true scale, and the whole point here is the mast.
  const vMax = Math.max(16, p.ridgeH + 4, p.baseH + 4, r.f1Mid * 2.2);
  const yOf = (m) => ground - (m / vMax) * (ground - 24);

  const bx = xOf(0);
  const rx = xOf(1);
  const by = yOf(p.baseH);
  const ry = yOf(p.roverH);

  const health = !r.up.up || !r.down.up ? BAD : r.up.goodput < VIDEO_FLOOR ? WARN : OK;

  // First Fresnel zone, sampled along the path and drawn around the LOS line.
  const N = 60;
  const top = [];
  const bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const f = fresnel(t * r.D, r.D, BANDS[p.band].fMHz);
    const los = p.baseH + (p.roverH - p.baseH) * t;
    const px = xOf(t);
    top.push(`${px.toFixed(1)},${yOf(los + f).toFixed(1)}`);
    bot.push(`${px.toFixed(1)},${yOf(los - f).toFixed(1)}`);
  }
  const fresnelPath = `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;

  const rgx = xOf(p.ridgeAt);
  const rgw = span * 0.075;

  // Base sector elevation lobe, drawn in true angle so the geometry lies about
  // nothing that matters. Length is arbitrary, the angle is not.
  const lobeLen = 130;
  const lobeAng = (deg) => ((deg * Math.PI) / 180);
  const half = r.vBase / 2;
  const lobePts = [-half, 0, half].map((a) => {
    const th = lobeAng(a + p.downtilt);
    return `${(bx + lobeLen * Math.cos(th)).toFixed(1)},${(by + lobeLen * Math.sin(th)).toFixed(1)}`;
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img"
         aria-label="Side view of the link showing mast height, line of sight, Fresnel zone and terrain">
      <defs>
        <linearGradient id="sl-fres" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--sl-accent)" stopOpacity="0.05" />
          <stop offset="50%" stopColor="var(--sl-accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--sl-accent)" stopOpacity="0.05" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width={W} height={H} rx="8" className={styles.sky} />

      {/* first Fresnel zone */}
      <path d={fresnelPath} fill="url(#sl-fres)" stroke="var(--sl-accent)"
            strokeOpacity="0.55" strokeDasharray="4 3" strokeWidth="1" />

      {/* base sector elevation lobe */}
      <polygon points={`${bx},${by} ${lobePts.join(' ')}`} fill={health} fillOpacity="0.13"
               stroke={health} strokeOpacity="0.4" strokeWidth="1" />

      {/* terrain */}
      <path
        d={`M0,${ground} L${(rgx - rgw).toFixed(1)},${ground} Q${rgx.toFixed(1)},${yOf(p.ridgeH * 1.35).toFixed(1)} ${(rgx + rgw).toFixed(1)},${ground} L${W},${ground} L${W},${H} L0,${H} Z`}
        className={styles.ground}
      />

      {/* line of sight */}
      <line x1={bx} y1={by} x2={rx} y2={ry} stroke={health} strokeWidth="2" />

      {/* masts */}
      <line x1={bx} y1={ground} x2={bx} y2={by} className={styles.mast} />
      <line x1={rx} y1={ground} x2={rx} y2={ry} className={styles.mast} />
      <circle cx={bx} cy={by} r="5" fill={health} />
      <circle cx={rx} cy={ry} r="5" fill={health} />

      <text x={bx - 8} y={by - 12} className={styles.lblR}>base {p.baseH} m</text>
      <text x={rx + 8} y={ry - 12} className={styles.lbl}>rover {p.roverH} m</text>

      {p.ridgeH > 0 && (
        <text x={rgx} y={yOf(p.ridgeH * 1.35) - 8} className={styles.lblC}>
          ridge {p.ridgeH} m
        </text>
      )}

      {/* distance ruler */}
      <line x1={bx} y1={H - 20} x2={rx} y2={H - 20} className={styles.ruler} />
      <text x={(bx + rx) / 2} y={H - 7} className={styles.lblC}>
        {r.D >= 1000 ? `${d1(r.D / 1000)} km` : `${d0(r.D)} m`}
      </text>

      <text x={padL} y={18} className={styles.cap}>
        first Fresnel zone {d1(r.f1Mid)} m radius at midpoint · vertical scale exaggerated
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- top view

function TopView({p, r}) {
  const S = 300;
  const bx = S / 2;
  const by = S - 26;
  const reach = S - 70;

  const half = p.baseHBeam / 2;
  const ang = (deg) => ((deg - 90) * Math.PI) / 180;
  const arc = (deg, rad) => `${(bx + rad * Math.cos(ang(deg))).toFixed(1)},${(by + rad * Math.sin(ang(deg))).toFixed(1)}`;

  const wedge = [];
  for (let a = -half; a <= half; a += 2) wedge.push(arc(a, reach));

  const rovX = bx + reach * Math.cos(ang(p.bearing));
  const rovY = by + reach * Math.sin(ang(p.bearing));
  const inBeam = Math.abs(p.bearing) <= half;

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className={styles.svg} role="img"
         aria-label="Top down view of the base sector beam and where the rover sits in it">
      <rect x="0" y="0" width={S} height={S} rx="8" className={styles.sky} />
      <circle cx={bx} cy={by} r={reach} className={styles.ring} />
      <polygon points={`${bx},${by} ${wedge.join(' ')}`}
               fill={inBeam ? OK : WARN} fillOpacity="0.16"
               stroke={inBeam ? OK : WARN} strokeOpacity="0.5" />
      <line x1={bx} y1={by} x2={bx} y2={by - reach} className={styles.boresight} />
      <line x1={bx} y1={by} x2={rovX} y2={rovY} stroke={inBeam ? OK : WARN} strokeWidth="1.5" />
      <circle cx={rovX} cy={rovY} r="5" fill={inBeam ? OK : WARN} />
      <text x={rovX} y={rovY - 10} className={styles.lblC}>rover</text>
      <text x={bx} y={by + 18} className={styles.lblC}>base sector</text>
      <text x={10} y={18} className={styles.cap}>{p.baseHBeam}° azimuth</text>
      <text x={10} y={32} className={styles.cap}>
        ±{d0(r.lateral)} m wide at {r.D >= 1000 ? `${d1(r.D / 1000)} km` : `${d0(r.D)} m`}
      </text>
      <text x={10} y={46} className={styles.cap}
            style={Math.abs(r.baseAz) > 3 ? {fill: WARN} : undefined}>
        off-boresight loss {d1(-r.baseAz)} dB
      </text>
    </svg>
  );
}

// ------------------------------------------------------- rover pattern view

function PatternView({p, r}) {
  const S = 240;
  const cx = S / 2;
  const cy = S / 2;
  const maxR = 86;
  const floor = 20; // dB below peak where we stop drawing

  const pts = [];
  for (let a = 0; a < 360; a += 3) {
    // Angle away from the antenna's own horizontal plane.
    const off = Math.min(Math.abs(((a + 90) % 180) - 90), 90);
    const g = rolloff(off, r.vRover, floor);
    const rad = 8 + maxR * ((g + floor) / floor);
    const th = ((a - p.tilt) * Math.PI) / 180;
    pts.push(`${(cx + rad * Math.cos(th)).toFixed(1)},${(cy + rad * Math.sin(th)).toFixed(1)}`);
  }

  // Direction the base station sits in, from the rover's point of view.
  const toBase = ((180 - r.elevDeg) * Math.PI) / 180;
  const lossNow = r.roverEff - p.roverGain;

  return (
    <svg viewBox={`0 0 ${S} ${S}`} className={styles.svg} role="img"
         aria-label="Elevation cut of the rover antenna pattern with the direction to the base station marked">
      <rect x="0" y="0" width={S} height={S} rx="8" className={styles.sky} />
      <circle cx={cx} cy={cy} r={maxR + 8} className={styles.ring} />
      <circle cx={cx} cy={cy} r={(maxR + 8) / 2} className={styles.ring} />
      <line x1={10} y1={cy} x2={S - 10} y2={cy} className={styles.boresight} />
      <polygon points={pts.join(' ')} fill={OK} fillOpacity="0.18" stroke={OK} strokeWidth="1.5" />
      <line x1={cx} y1={cy} x2={cx + (maxR + 14) * Math.cos(toBase)} y2={cy + (maxR + 14) * Math.sin(toBase)}
            stroke={lossNow < -6 ? BAD : lossNow < -3 ? WARN : OK} strokeWidth="2" strokeDasharray="5 3" />
      <circle cx={cx} cy={cy} r="4" className={styles.dot} />
      <text x={10} y={18} className={styles.cap}>rover pattern, elevation cut</text>
      <text x={10} y={32} className={styles.cap}>{d1(r.vRover)}° tall · tilted {p.tilt}°</text>
      <text x={10} y={S - 10} className={styles.cap}
            style={lossNow < -3 ? {fill: lossNow < -6 ? BAD : WARN} : undefined}>
        {d1(-lossNow)} dB lost off the peak
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- the chart

function RangeChart({p, sweep, r}) {
  const W = 900;
  const H = 170;
  const padL = 46;
  const padB = 26;
  const padT = 14;
  const padR = 12;
  const maxD = sweep.maxD;
  const maxY = Math.max(20, ...sweep.rows.map((s) => Math.max(s.up, s.down)));

  const xOf = (d) => padL + (d / maxD) * (W - padL - padR);
  const yOf = (v) => H - padB - (v / maxY) * (H - padB - padT);

  const line = (key) => sweep.rows.map((s, i) => `${i ? 'L' : 'M'}${xOf(s.d).toFixed(1)},${yOf(s[key]).toFixed(1)}`).join('');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxD);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img"
         aria-label="Estimated goodput against distance for both directions of the link">
      <rect x="0" y="0" width={W} height={H} rx="8" className={styles.sky} />

      <line x1={padL} y1={yOf(VIDEO_FLOOR)} x2={W - padR} y2={yOf(VIDEO_FLOOR)}
            stroke={WARN} strokeDasharray="4 4" strokeWidth="1" />
      <text x={W - padR - 4} y={yOf(VIDEO_FLOOR) - 4} className={styles.lblR} style={{fill: WARN}}>
        {VIDEO_FLOOR} Mbps video floor
      </text>

      <path d={line('down')} fill="none" stroke="var(--sl-accent)" strokeWidth="2" strokeDasharray="5 3" />
      <path d={line('up')} fill="none" stroke={OK} strokeWidth="2.5" />

      <line x1={xOf(r.D)} y1={padT} x2={xOf(r.D)} y2={H - padB} className={styles.cursor} />
      <circle cx={xOf(r.D)} cy={yOf(Math.min(r.up.goodput, maxY))} r="4" fill={OK} />

      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className={styles.axis} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} className={styles.axis} />
      {ticks.map((t) => (
        <text key={t} x={xOf(t)} y={H - 8} className={styles.lblC}>{d1(t / 1000)} km</text>
      ))}
      <text x={4} y={yOf(maxY) + 10} className={styles.cap}>{d0(maxY)}</text>
      <text x={4} y={H - padB} className={styles.cap}>0</text>
      <text x={padL + 6} y={padT + 10} className={styles.cap}>
        Mbps goodput · solid = rover to base (video) · dashed = base to rover (control)
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- panels

function DirPanel({title, sub, dir, p, tag}) {
  const cls = !dir.up ? styles.bad : dir.margin < 6 ? styles.warn : styles.ok;
  return (
    <div className={`${styles.panel} ${cls}`}>
      <h5>{title} <small>{sub}</small></h5>
      <table className={styles.kv}>
        <tbody>
          <tr><td>Radio TX</td><td>{d1(dir.tx)} dBm <span className={styles.dim}>at MCS{Math.max(dir.mcs, 0)}</span></td></tr>
          <tr>
            <td>EIRP</td>
            <td>
              {d1(dir.eirp)} dBm
              {dir.capped && <span className={styles.capTag}> capped from {d1(dir.eirpRaw)}</span>}
            </td>
          </tr>
          <tr><td>Received</td><td><b>{d1(dir.rx)} dBm</b></td></tr>
          <tr><td>Sensitivity</td><td>{d1(dir.sens)} dBm</td></tr>
          <tr><td>Margin</td><td><b>{dir.margin >= 0 ? '+' : ''}{d1(dir.margin)} dB</b></td></tr>
          <tr>
            <td>Rate</td>
            <td>{dir.up ? `MCS${dir.mcs} · ${d0(dir.phy)} Mbps PHY` : 'no rate closes'}</td>
          </tr>
          <tr><td>Goodput</td><td><b>{d1(dir.goodput)} Mbps</b> <span className={styles.dim}>{tag}</span></td></tr>
        </tbody>
      </table>
    </div>
  );
}

function InfoPanel() {
  return (
    <div className={styles.info}>
      <h5>What the model actually computes</h5>
      <p>
        Path loss is Friis in the usual engineering form,
        {' '}<code>FSPL = 20log₁₀(d_km) + 20log₁₀(f_MHz) + 32.44</code>, which is 108 dB at 1 km on
        5.8 GHz and 100 dB on 2.4 GHz. The first Fresnel zone is
        {' '}<code>√(λ·d₁·d₂ / D)</code>, and terrain poking into it is scored with the ITU-R P.526
        single knife-edge approximation. That is why the 60% clearance rule falls out on its own:
        below 0.6 of a Fresnel radius the diffraction parameter crosses <code>-0.78</code> and the
        loss stops being zero.
      </p>
      <p>
        Antenna gain off boresight uses the standard main-lobe rolloff,
        {' '}<code>-12·(θ/θ₃dB)²</code>, floored at the sidelobe level. The base sector's gain and
        its two beamwidths are separate sliders on purpose, because the whole point is that they
        have to agree: <code>D ≈ 41253 / (H° × V°)</code> is the ceiling any real antenna obeys.
        A claimed gain above that ceiling is not achievable, so the lab quietly derates it to what
        the beamwidth can actually produce, which is what the real antenna would have done to you
        anyway. The rover omni uses the same identity with 360° of azimuth, which is exactly why a
        9 dBi omni is a thin disc and a 3 dBi one is not.
      </p>

      <h5>The rate ladder</h5>
      <p>
        Rates and sensitivities are the NetMetal ax datasheet: 802.11ax, two spatial streams, and a
        20 MHz sensitivity curve anchored on the three published points (-96 dBm at MCS0, -70 at
        MCS9, -67 at MCS11). Channel width scales the rate and moves the noise floor by
        {' '}<code>10log₁₀(BW/20)</code>, so every halving of bandwidth buys about 3 dB. The radio
        also backs its own power off as the constellation gets denser, 28 dBm at the bottom rung
        down to 20 dBm at MCS11, so the lab walks the ladder from the top and takes the first rate
        that closes at its own reduced power.
      </p>

      <h5>The regulatory ceiling</h5>
      <p>
        Under Part 15 point-to-multipoint you give back 1 dB of conducted power for every 1 dB of
        antenna gain past 6 dBi, which pins EIRP at 36 dBm no matter what you bolt on the mast.
        Point-to-point is looser: 5.8 GHz hands you the gain for free and 2.4 GHz only takes back
        1 dB per 3. The cap is computed on peak gain, the way it gets measured, while the link uses
        the off-axis gain. Switching the mode to <i>ignore</i> is there to show you what the rules
        are costing you, not as an operating suggestion.
      </p>

      <h5>What it simplifies</h5>
      <ul>
        <li>Goodput is a flat {Math.round(MAC_EFFICIENCY * 100)}% of PHY rate. Real 802.11ax
          efficiency moves with frame size, aggregation, and how much airtime the other direction
          is eating.</li>
        <li>One knife edge. Real desert is many soft edges plus ground reflection, and a two-ray
          model would show nulls this does not.</li>
        <li>No multipath, no fading, no rain, no foliage, and no polarization mismatch.</li>
        <li>Rate control is instant and perfect. Real rate control lags and hunts, which is part of
          why you want margin rather than a link that just barely closes.</li>
        <li>MIMO is counted as two streams of rate, not as spatial diversity against fades. On a
          real desert path the diversity is often worth more than the rate.</li>
      </ul>
      <p className={styles.infoFoot}>
        The physics is real and the datasheet numbers are real. Use it to build intuition for which
        knob matters, then go drive-test with RSSI logging before you trust any of it at competition.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- component

export default function SignalLab() {
  const [p, setP] = useState(DEFAULTS);
  const [showInfo, setShowInfo] = useState(false);

  const set = (k) => (v) => setP((s) => ({...s, [k]: v}));
  const preset = (patch) => setP({...DEFAULTS, ...patch});

  const r = useMemo(() => solve(p, p.distance), [p]);

  const sweep = useMemo(() => {
    const maxD = 5000;
    const rows = [];
    let linkRange = 0;
    let videoRange = 0;
    for (let d = 50; d <= maxD; d += 50) {
      const s = solve(p, d);
      rows.push({d, up: s.up.goodput, down: s.down.goodput});
      if (s.up.up && s.down.up) linkRange = d;
      if (s.up.goodput >= VIDEO_FLOOR && s.down.up) videoRange = d;
    }
    return {maxD, rows, linkRange, videoRange};
  }, [p]);

  // The sweep stops at 5 km. Saying "5.0 km" when the link never broke would
  // read like a computed answer instead of the edge of the chart.
  const range = (m) => (m >= sweep.maxD ? `> ${d1(sweep.maxD / 1000)} km` : `${d1(m / 1000)} km`);

  const linkUp = r.up.up && r.down.up;
  const verdict = !linkUp
    ? {txt: 'Link is down. Nothing closes, not even the bottom rate.', cls: 'bad'}
    : r.up.goodput < VIDEO_FLOOR
    ? {txt: `Control survives but video starves at ${d1(r.up.goodput)} Mbps.`, cls: 'warn'}
    : {txt: `Video and control both fit, with ${d1(Math.min(r.up.margin, r.down.margin))} dB of margin on the worse direction.`, cls: 'ok'};

  const worse = r.up.margin <= r.down.margin ? 'rover to base' : 'base to rover';

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>Link lab: what each spec actually buys you</span>
        <button className={styles.infoBtn} aria-expanded={showInfo} onClick={() => setShowInfo((v) => !v)}>
          <span className={styles.infoMark}>i</span> How this works
        </button>
      </div>

      {showInfo && <InfoPanel />}

      <div className={styles.scenarios}>
        <span className={styles.scenLbl}>Try a scenario:</span>
        {Object.entries(PRESETS).map(([name, patch]) => (
          <button key={name} className={styles.scenBtn} onClick={() => preset(patch)}>{name}</button>
        ))}
      </div>

      <div className={styles.scenes}>
        <div className={styles.sceneMain}><SideView p={p} r={r} /></div>
        <div className={styles.sceneSide}>
          <TopView p={p} r={r} />
          <PatternView p={p} r={r} />
        </div>
      </div>

      <div className={`${styles.verdict} ${styles[verdict.cls]}`}>{verdict.txt}</div>

      <div className={styles.panels}>
        <DirPanel
          title="Base → rover" sub="the joystick" dir={r.down} p={p}
          tag="control needs ~0.5 Mbps"
        />
        <DirPanel
          title="Rover → base" sub="the cameras" dir={r.up} p={p}
          tag={`video needs ~${VIDEO_FLOOR} Mbps`}
        />
        <div className={styles.panel}>
          <h5>The path <small>shared by both</small></h5>
          <table className={styles.kv}>
            <tbody>
              <tr><td>Free space loss</td><td>{d1(r.fsplDb)} dB</td></tr>
              <tr>
                <td>Obstruction</td>
                <td>{r.obstruction > 0.05 ? <b>{d1(r.obstruction)} dB</b> : 'none'}</td>
              </tr>
              <tr><td>Fresnel radius</td><td>{d1(r.f1Mid)} m at midpoint</td></tr>
              <tr>
                <td>Clearance</td>
                <td>{p.ridgeH > 0 ? `${d0(r.clearance * 100)}% of F1 at the ridge` : 'nothing in the way'}</td>
              </tr>
              <tr><td>Beam width on ground</td><td>±{d0(r.lateral)} m at this range</td></tr>
              <tr><td>Link holds out to</td><td><b>{range(sweep.linkRange)}</b></td></tr>
              <tr><td>Video holds out to</td><td><b>{range(sweep.videoRange)}</b></td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <RangeChart p={p} sweep={sweep} r={r} />

      <p className={styles.hintLine}>
        The tighter direction right now is <b>{worse}</b>. That is the one worth spending money on.
      </p>

      <div className={styles.controls}>
        <div className={styles.group}>
          <h6>Geometry</h6>
          <Slider label="Distance" value={p.distance} min={50} max={2500} step={25} unit=" m" onChange={set('distance')} />
          <Slider label="Base mast height" value={p.baseH} min={1} max={12} step={0.5} unit=" m" onChange={set('baseH')}
                  hint="the single most powerful knob on this page" />
          <Slider label="Rover antenna height" value={p.roverH} min={0.2} max={3} step={0.1} unit=" m" onChange={set('roverH')} />
          <Slider label="Ridge height" value={p.ridgeH} min={0} max={20} step={0.5} unit=" m" onChange={set('ridgeH')}
                  hint="0 means clear desert" />
          <Slider label="Ridge position" value={Math.round(p.ridgeAt * 100)} min={10} max={90} step={5} unit="% of path"
                  onChange={(v) => set('ridgeAt')(v / 100)} disabled={p.ridgeH === 0} />
        </div>

        <div className={styles.group}>
          <h6>Base station</h6>
          <Slider label="TX power" value={p.baseTx} min={5} max={30} step={1} unit=" dBm" onChange={set('baseTx')} />
          <Slider label="Claimed gain" value={p.baseGain} min={3} max={27} step={0.5} unit=" dBi" onChange={set('baseGain')}
                  hint={<SpecCheck claimed={p.baseGain} implied={r.impliedGain} />} />
          <Slider label="Azimuth beamwidth" value={p.baseHBeam} min={8} max={120} step={2} unit="°" onChange={set('baseHBeam')} />
          <Slider label="Elevation beamwidth" value={p.baseVBeam} min={4} max={90} step={1} unit="°" onChange={set('baseVBeam')} />
          <Slider label="Rover off boresight" value={p.bearing} min={0} max={90} step={1} unit="°" onChange={set('bearing')} />
          <Slider label="Mechanical downtilt" value={p.downtilt} min={0} max={15} step={1} unit="°" onChange={set('downtilt')} />
          <Slider label="Coax loss" value={p.baseCable} min={0} max={20} step={0.2} unit=" dB" onChange={set('baseCable')}
                  hint="1 m LMR-240 ≈ 0.4 · 25 m LMR-400 ≈ 18" />
        </div>

        <div className={styles.group}>
          <h6>Rover</h6>
          <Slider label="TX power" value={p.roverTx} min={5} max={30} step={1} unit=" dBm" onChange={set('roverTx')} />
          <Slider label="Antenna gain" value={p.roverGain} min={2} max={12} step={0.1} unit=" dBi" onChange={set('roverGain')}
                  hint={`toroid is ${d1(r.vRover)}° tall`} />
          <Slider label="Pitch on the slope" value={p.tilt} min={0} max={45} step={1} unit="°" onChange={set('tilt')} />
          <Slider label="Pigtail loss" value={p.roverCable} min={0} max={4} step={0.1} unit=" dB" onChange={set('roverCable')} />
        </div>

        <div className={styles.group}>
          <h6>Channel and rules</h6>
          <Pills label="Band" value={p.band} options={[['2.4', '2.4 GHz'], ['5.8', '5.8 GHz']]} onChange={set('band')} />
          <Pills label="Channel width" value={p.width}
                 options={[[10, '10'], [20, '20'], [40, '40'], [80, '80 MHz']]} onChange={set('width')} />
          <Pills label="Part 15 mode" value={p.reg}
                 options={[['ptmp', 'multipoint'], ['p2p', 'point to point'], ['off', 'ignore']]} onChange={set('reg')} />
          <Slider label="Interference above thermal" value={p.interference} min={0} max={25} step={1} unit=" dB"
                  onChange={set('interference')} hint="competition day, everyone transmitting" />
          <label className={styles.check}>
            <input type="checkbox" checked={p.ackSet} onChange={() => set('ackSet')(!p.ackSet)} />
            <span>ACK timeout set for the link length</span>
          </label>
        </div>
      </div>
    </div>
  );
}
