import React, {useMemo, useRef, useState} from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './SignalLab.module.css';
import {SITES, SPAN_M, contourBands, distanceToEdge} from './terrainModel';
import {
  BANDS,
  CONTROL_FLOOR,
  DEFAULTS,
  MAC_EFFICIENCY,
  PRESETS,
  SHADOW_SIGMA,
  VIDEO_FLOOR,
  clamp,
  dbToLin,
  fresnel,
  log10,
  rolloff,
  solve,
} from './signalModel';

// The interactive view. All of the physics lives in signalModel.js; everything
// here is presentation, inline SVG and pointer handling.
// SSR-safe: no browser APIs outside event handlers.
const OK = '#4caf50';
const WARN = '#e5a73c';
const BAD = '#e06c75';

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
const pct = (x) => `${Math.round(clamp(x, 0, 9.99) * 100)}%`;

// D ≈ 41253 / (H° × V°). If the claimed gain doesn't agree with the claimed
// beamwidth, one of the two numbers is fiction. This is the cheapest way to
// catch a marketplace listing that has been sexed up by 5 dB. Always judged at
// 5.8 GHz, because that is what the sliders describe.
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
  // invisible at true scale, and the whole point here is the mast. On the map
  // the axis becomes real elevation, so it has to fit the cut of ground the
  // path actually crosses.
  const prof = r.profile;
  let zFloor;
  let zSpan;
  if (prof) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < prof.length; i++) {
      if (prof[i] < lo) lo = prof[i];
      if (prof[i] > hi) hi = prof[i];
    }
    hi = Math.max(hi, r.baseZ, r.roverZ);
    lo = Math.min(lo, r.baseZ - 2, r.roverZ - 2);
    const pad = Math.max(6, (hi - lo) * 0.2, r.f1Mid * 1.3);
    zFloor = lo - pad * 0.3;
    zSpan = hi - zFloor + pad;
  } else {
    zFloor = 0;
    zSpan = Math.max(16, p.ridgeH + 4, p.baseH + 4, r.f1Mid * 2.2);
  }
  const yOf = (z) => ground - ((z - zFloor) / zSpan) * (ground - 24);

  const bx = xOf(0);
  const rx = xOf(1);
  const by = yOf(r.baseZ);
  const ry = yOf(r.roverZ);

  const health = !r.fits ? (!r.up.up || !r.down.up ? BAD : WARN) : OK;

  // First Fresnel zone, sampled along the path and drawn around the LOS line.
  const N = 60;
  const top = [];
  const bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const f = fresnel(t * r.D, r.D, BANDS[p.band].fMHz);
    const los = r.baseZ + (r.roverZ - r.baseZ) * t;
    const px = xOf(t);
    top.push(`${px.toFixed(1)},${yOf(los + f).toFixed(1)}`);
    bot.push(`${px.toFixed(1)},${yOf(los - f).toFixed(1)}`);
  }
  const fresnelPath = `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;

  // The ground bounce. Reflection point splits the path in proportion to the
  // two antenna heights.
  const bounceFrac = p.baseH / (p.baseH + p.roverH);
  const bnx = xOf(bounceFrac);
  const bnz = prof
    ? prof[clamp(Math.round(bounceFrac * (prof.length - 1)), 0, prof.length - 1)]
    : 0;
  const bny = yOf(bnz);

  // Terrain: the real cut of ground under the path, or the synthetic hump.
  const groundPath = prof
    ? `M0,${yOf(prof[0]).toFixed(1)} ` +
      prof
        .reduce((acc, z, i) => {
          acc.push(`L${xOf(i / (prof.length - 1)).toFixed(1)},${yOf(z).toFixed(1)}`);
          return acc;
        }, [])
        .join(' ') +
      ` L${W},${yOf(prof[prof.length - 1]).toFixed(1)} L${W},${H} L0,${H} Z`
    : null;

  const rgFrac = clamp(p.ridgeD / r.D, 0, 1);
  const rgx = xOf(rgFrac);
  const rgw = span * 0.075;
  const pinchX = xOf(clamp(r.pinchAt / r.D, 0, 1));

  // Base sector elevation lobe, drawn in true angle so the geometry lies about
  // nothing that matters. Length is arbitrary, the angle is not.
  const lobeLen = 130;
  const lobeAng = (deg) => ((deg * Math.PI) / 180);
  const half = r.vBase / 2;
  const lobePts = [-half, 0, half].map((a) => {
    const th = lobeAng(a + p.downtilt);
    return `${(bx + lobeLen * Math.cos(th)).toFixed(1)},${(by + lobeLen * Math.sin(th)).toFixed(1)}`;
  });

  const groundTxt =
    r.ground > 0.2
      ? `ground bounce costs ${d1(r.ground)} dB`
      : r.ground < -0.2
      ? `ground bounce adds ${d1(-r.ground)} dB`
      : 'ground bounce neutral here';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img"
         aria-label="Side view of the link showing mast height, line of sight, Fresnel zone, the ground reflection and terrain">
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
        d={
          groundPath ||
          `M0,${ground} L${(rgx - rgw).toFixed(1)},${ground} Q${rgx.toFixed(1)},${yOf(p.ridgeH * 1.35).toFixed(1)} ${(rgx + rgw).toFixed(1)},${ground} L${W},${ground} L${W},${H} L0,${H} Z`
        }
        className={styles.ground}
      />

      {/* the ground bounce, the ray a Friis-only budget forgets */}
      <path d={`M${bx},${by} L${bnx.toFixed(1)},${(prof ? bny : ground).toFixed(1)} L${rx},${ry}`}
            fill="none" stroke={WARN} strokeWidth="1.2" strokeDasharray="3 3" strokeOpacity="0.75" />
      <circle cx={bnx} cy={prof ? bny : ground} r="3" fill={WARN} fillOpacity="0.8" />

      {/* where the Fresnel zone is pinched tightest */}
      {r.ridgeInPath && (
        <line x1={pinchX} y1={24} x2={pinchX} y2={ground} stroke={BAD}
              strokeWidth="1" strokeDasharray="2 4" strokeOpacity="0.7" />
      )}

      {/* line of sight */}
      <line x1={bx} y1={by} x2={rx} y2={ry} stroke={health} strokeWidth="2" />

      {/* masts */}
      <line x1={bx} y1={prof ? yOf(r.groundBase) : ground} x2={bx} y2={by} className={styles.mast} />
      <line x1={rx} y1={prof ? yOf(r.groundRover) : ground} x2={rx} y2={ry} className={styles.mast} />
      <circle cx={bx} cy={by} r="5" fill={health} />
      <circle cx={rx} cy={ry} r="5" fill={health} />

      <text x={bx - 8} y={by - 12} className={styles.lblR}>
        base {p.baseH} m{prof ? ` · ${d0(r.groundBase)} m` : ''}
      </text>
      <text x={rx + 8} y={ry - 12} className={styles.lbl}>
        rover {p.roverH} m{prof ? ` · ${d0(r.groundRover)} m` : ''}
      </text>

      {!prof && r.ridgeInPath && (
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
        {prof ? ` · ground ${d0(zFloor)}–${d0(zFloor + zSpan)} m` : ''}
      </text>
      <text x={padL} y={32} className={styles.cap}
            style={r.ground > 3 ? {fill: WARN} : undefined}>
        {groundTxt}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- map view

const compass = (de, dn) => ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
const MAP_S = 1000; // the map's own unit square
const MAX_Z = 8;

// Top-down USGS orthoimagery and terrain for the chosen site. Drag the base
// anywhere, swing the aim handle to point the sector, and drag the rover to set
// both the heading and the range. Drag the background to pan; the buttons and a
// double-click zoom. Everything the propagation model needs is read off this.
function MapView({p, r, view, setView, onChange}) {
  const drag = useRef(null);
  const bands = useMemo(() => contourBands(p.site), [p.site]);
  const site = SITES.find((s) => s.id === p.site) || SITES[0];
  const imgSrc = useBaseUrl(site.image);

  // Half the visible span, in map units. Everything on screen that should keep
  // a constant size gets multiplied by k to undo the zoom.
  const halfV = MAP_S / (2 * view.z);
  const k = 1 / view.z;

  const xOf = (e) => ((e + SPAN_M / 2) / SPAN_M) * MAP_S;
  const yOf = (n) => ((SPAN_M / 2 - n) / SPAN_M) * MAP_S;
  const unitToM = (u) => (u / MAP_S) * SPAN_M;

  const bx = xOf(p.baseE);
  const by = yOf(p.baseN);
  const rx = xOf(r.roverE);
  const ry = yOf(r.roverN);

  // The aim handle sits at a constant distance on screen, not on the ground,
  // so it stays reachable at every zoom level.
  const aimR = unitToM(halfV * 0.34);
  const aimTh = (p.aim * Math.PI) / 180;
  const aimE = p.baseE + aimR * Math.sin(aimTh);
  const aimN = p.baseN + aimR * Math.cos(aimTh);
  const ax = xOf(aimE);
  const ay = yOf(aimN);

  const half = r.hBase / 2;
  const reach = Math.max(r.D, 400);
  const wedge = [];
  for (let a = -half; a <= half + 0.01; a += Math.max(1, half / 12)) {
    const th = ((p.aim + a) * Math.PI) / 180;
    wedge.push(`${xOf(p.baseE + reach * Math.sin(th)).toFixed(1)},${yOf(p.baseN + reach * Math.cos(th)).toFixed(1)}`);
  }

  const pinchT = clamp(r.pinchAt / r.D, 0, 1);
  const px = bx + (rx - bx) * pinchT;
  const py = by + (ry - by) * pinchT;
  const health = !r.fits ? (!r.up.up || !r.down.up ? BAD : WARN) : OK;

  // --- pointer plumbing

  function locate(ev) {
    const box = ev.currentTarget.getBoundingClientRect();
    const span = 2 * halfV;
    const ux = view.cx - halfV + ((ev.clientX - box.left) / box.width) * span;
    const uy = view.cy - halfV + ((ev.clientY - box.top) / box.height) * span;
    return {
      ux, uy,
      e: (ux / MAP_S - 0.5) * SPAN_M,
      n: (0.5 - uy / MAP_S) * SPAN_M,
      unitsPerPx: span / Math.max(box.width, 1),
    };
  }

  const clampView = (cx, cy, z) => ({
    z,
    cx: clamp(cx, MAP_S / (2 * z), MAP_S - MAP_S / (2 * z)),
    cy: clamp(cy, MAP_S / (2 * z), MAP_S - MAP_S / (2 * z)),
  });

  // Zoom about a fixed point, so the ground under the cursor stays put:
  //   cx' = cx + (ux - cx) * (1 - z/z')
  const zoomBy = (factor, ux, uy) =>
    setView((v) => {
      const nz = clamp(v.z * factor, 1, MAX_Z);
      const f = 1 - v.z / nz;
      return {...clampView(v.cx + (ux - v.cx) * f, v.cy + (uy - v.cy) * f, nz), layer: v.layer};
    });

  function onDown(ev) {
    const m = locate(ev);
    const tol = unitToM(m.unitsPerPx * 20);
    const near = [
      ['rover', Math.hypot(m.e - r.roverE, m.n - r.roverN)],
      ['aim', Math.hypot(m.e - aimE, m.n - aimN)],
      ['base', Math.hypot(m.e - p.baseE, m.n - p.baseN)],
    ].filter(([, d]) => d < tol).sort((a, b) => a[1] - b[1])[0];

    drag.current = near
      ? {mode: near[0]}
      : {mode: 'pan', x0: ev.clientX, y0: ev.clientY, cx0: view.cx, cy0: view.cy,
         scale: m.unitsPerPx};
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }

  function onMove(ev) {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView((v) => ({
        ...clampView(d.cx0 - (ev.clientX - d.x0) * d.scale, d.cy0 - (ev.clientY - d.y0) * d.scale, v.z),
        layer: v.layer,
      }));
      return;
    }
    const m = locate(ev);
    const edge = SPAN_M / 2 - 100;
    if (d.mode === 'base') {
      onChange({baseE: Math.round(clamp(m.e, -edge, edge)), baseN: Math.round(clamp(m.n, -edge, edge))});
    } else if (d.mode === 'aim') {
      onChange({aim: Math.round(compass(m.e - p.baseE, m.n - p.baseN))});
    } else {
      const de = m.e - p.baseE;
      const dn = m.n - p.baseN;
      const dist = Math.hypot(de, dn);
      if (dist < 25) return;
      onChange({
        heading: Math.round(compass(de, dn)),
        distance: Math.round(clamp(dist, 50, 2500) / 25) * 25,
      });
    }
  }

  function onUp(ev) {
    drag.current = null;
    if (ev.currentTarget.hasPointerCapture?.(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  }

  function onDoubleClick(ev) {
    const m = locate(ev);
    zoomBy(2, m.ux, m.uy);
  }

  // --- chrome that must stay a constant size on screen

  // Pick a scale bar that lands near a third of the visible width.
  const visibleM = unitToM(2 * halfV);
  const barM = [2000, 1000, 500, 200, 100, 50].find((v) => v <= visibleM * 0.38) || 50;
  const barU = (barM / SPAN_M) * MAP_S;
  const vx0 = view.cx - halfV;
  const vy0 = view.cy - halfV;
  const pad = 26 * k;

  const rings = [500, 1000, 2000, 4000].filter((d) => d <= SPAN_M);

  return (
    <svg viewBox={`${vx0} ${vy0} ${2 * halfV} ${2 * halfV}`} className={`${styles.svg} ${styles.map}`}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
         onDoubleClick={onDoubleClick}
         role="img"
         aria-label={`Top-down satellite map of ${site.name} at ${view.z}x zoom. Base station on ground at ${d0(r.groundBase)} metres elevation, rover ${d0(r.D)} metres away on a bearing of ${d0(p.heading)} degrees.`}>
      <defs>
        <clipPath id="sl-mapclip"><rect x="0" y="0" width={MAP_S} height={MAP_S} /></clipPath>
      </defs>

      <g clipPath="url(#sl-mapclip)">
        {/* Contours sit underneath as the backdrop, so the map still reads if
            the imagery has not arrived or failed to load. */}
        {bands.map((b, i) => <path key={i} d={b.d} fill={b.fill} />)}

        {view.layer !== 'topo' && (
          <image href={imgSrc} x="0" y="0" width={MAP_S} height={MAP_S}
                 preserveAspectRatio="none" />
        )}
        {view.layer === 'both' && (
          <g opacity="0.38">
            {bands.map((b, i) => <path key={i} d={b.d} fill={b.fill} />)}
          </g>
        )}

        {rings.map((d) => (
          <circle key={d} cx={bx} cy={by} r={(d / SPAN_M) * MAP_S} fill="none"
                  stroke="#fff" strokeOpacity="0.3" strokeWidth={1.4 * k} strokeDasharray={`${5 * k} ${5 * k}`} />
        ))}

        <polygon points={`${bx},${by} ${wedge.join(' ')}`} fill={health} fillOpacity="0.2"
                 stroke={health} strokeOpacity="0.65" strokeWidth={1.5 * k} />

        <line x1={bx} y1={by} x2={rx} y2={ry} stroke="#000" strokeOpacity="0.45" strokeWidth={4.5 * k} />
        <line x1={bx} y1={by} x2={rx} y2={ry} stroke={health} strokeWidth={2.5 * k} />

        {r.ridgeInPath && (
          <>
            <circle cx={px} cy={py} r={7 * k} fill="none" stroke={BAD} strokeWidth={2.5 * k} />
            <circle cx={px} cy={py} r={2.5 * k} fill={BAD} />
          </>
        )}

        <line x1={bx} y1={by} x2={ax} y2={ay} stroke="#fff" strokeOpacity="0.8"
              strokeWidth={1.5 * k} strokeDasharray={`${4 * k} ${4 * k}`} />
        <g transform={`translate(${ax} ${ay}) scale(${k})`}>
          <circle cx="0" cy="0" r="11" fill="#fff" fillOpacity="0.92" stroke="#000" strokeOpacity="0.5" strokeWidth="1.5" />
          <path d="M-4,3 L0,-5 L4,3 Z" fill="#000" fillOpacity="0.72" transform={`rotate(${p.aim})`} />
        </g>

        <g transform={`translate(${bx} ${by}) scale(${k})`}>
          <rect x="-8" y="-8" width="16" height="16" rx="3" fill="#fff" stroke="#000" strokeOpacity="0.6" strokeWidth="2" />
          <rect x="-4" y="-4" width="8" height="8" rx="1.5" fill={health} />
        </g>
        <g transform={`translate(${rx} ${ry}) scale(${k})`}>
          <circle cx="0" cy="0" r="8.5" fill="#fff" stroke="#000" strokeOpacity="0.6" strokeWidth="2" />
          <circle cx="0" cy="0" r="4" fill={health} />
        </g>
      </g>

      {/* north arrow and scale bar, held at a constant screen size */}
      <g transform={`translate(${vx0 + pad} ${vy0 + pad}) scale(${k})`} opacity="0.92">
        <line x1="0" y1="52" x2="0" y2="8" stroke="#fff" strokeWidth="2.5" />
        <path d="M-6,18 L0,4 L6,18 Z" fill="#fff" />
        <text x="0" y="70" className={styles.mapLbl} textAnchor="middle">N</text>
      </g>
      <g transform={`translate(${view.cx + halfV - pad} ${view.cy + halfV - pad})`} opacity="0.92">
        <line x1={-barU} y1="0" x2="0" y2="0" stroke="#fff" strokeWidth={3 * k} />
        <line x1={-barU} y1={-4 * k} x2={-barU} y2={4 * k} stroke="#fff" strokeWidth={3 * k} />
        <line x1="0" y1={-4 * k} x2="0" y2={4 * k} stroke="#fff" strokeWidth={3 * k} />
        <g transform={`scale(${k})`}>
          <text x="0" y="-12" className={styles.mapLbl} textAnchor="end">
            {barM >= 1000 ? `${barM / 1000} km` : `${barM} m`}
          </text>
        </g>
      </g>
    </svg>
  );
}
// ---------------------------------------------------------------- top view

function TopView({p, r}) {
  const S = 300;
  const bx = S / 2;
  const by = S - 26;
  const reach = S - 70;

  const half = r.hBase / 2;
  const ang = (deg) => ((deg - 90) * Math.PI) / 180;
  const arc = (deg, rad) => `${(bx + rad * Math.cos(ang(deg))).toFixed(1)},${(by + rad * Math.sin(ang(deg))).toFixed(1)}`;

  const wedge = [];
  for (let a = -half; a <= half; a += 2) wedge.push(arc(a, reach));

  const rovX = bx + reach * Math.cos(ang(r.bearingOff));
  const rovY = by + reach * Math.sin(ang(r.bearingOff));
  const inBeam = Math.abs(r.bearingOff) <= half;

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
      <text x={10} y={18} className={styles.cap}>{d0(r.hBase)}° azimuth on {BANDS[p.band].label}</text>
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
  const lossNow = r.roverRolloff;

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
      <text x={10} y={32} className={styles.cap}>
        {d1(r.vRover)}° tall · {d1(r.roverGain)} dBi · pitched {p.tilt}°
      </text>
      <text x={10} y={S - 10} className={styles.cap}
            style={lossNow < -3 ? {fill: lossNow < -6 ? BAD : WARN} : undefined}>
        {d1(-lossNow)} dB lost off the peak
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- the chart

function RangeChart({sweep, r}) {
  const W = 900;
  const H = 170;
  const padL = 46;
  const padB = 26;
  const padT = 14;
  const padR = 12;
  const maxD = sweep.maxD;
  const maxY = Math.max(20, ...sweep.rows.map((s) => Math.max(s.up, s.down)));

  const xOf = (d) => padL + (d / maxD) * (W - padL - padR);
  const yOf = (v) => H - padB - (clamp(v, 0, maxY) / maxY) * (H - padB - padT);

  const line = (key) =>
    sweep.rows.map((s, i) => `${i ? 'L' : 'M'}${xOf(s.d).toFixed(1)},${yOf(s[key]).toFixed(1)}`).join('');

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxD);
  const fitsX = sweep.videoRange <= maxD ? xOf(sweep.videoRange) : null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img"
         aria-label="Estimated per-direction capacity against distance, with the range where the whole mission still fits in the channel">
      <rect x="0" y="0" width={W} height={H} rx="8" className={styles.sky} />

      <line x1={padL} y1={yOf(VIDEO_FLOOR)} x2={W - padR} y2={yOf(VIDEO_FLOOR)}
            stroke={WARN} strokeDasharray="4 4" strokeWidth="1" />
      <text x={W - padR - 4} y={yOf(VIDEO_FLOOR) - 4} className={styles.lblR} style={{fill: WARN}}>
        {VIDEO_FLOOR} Mbps video floor
      </text>

      <path d={line('down')} fill="none" stroke="var(--sl-accent)" strokeWidth="2" strokeDasharray="5 3" />
      <path d={line('up')} fill="none" stroke={OK} strokeWidth="2.5" />

      {fitsX !== null && (
        <>
          <line x1={fitsX} y1={padT} x2={fitsX} y2={H - padB} stroke={BAD} strokeWidth="1.5" strokeDasharray="3 3" />
          <text x={fitsX - 4} y={padT + 10} className={styles.lblR} style={{fill: BAD}}>
            first video dropout
          </text>
        </>
      )}

      <line x1={xOf(r.D)} y1={padT} x2={xOf(r.D)} y2={H - padB} className={styles.cursor} />
      <circle cx={xOf(r.D)} cy={yOf(r.up.capacity)} r="4" fill={OK} />

      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className={styles.axis} />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} className={styles.axis} />
      {ticks.map((t) => (
        <text key={t} x={xOf(t)} y={H - 8} className={styles.lblC}>{d1(t / 1000)} km</text>
      ))}
      <text x={4} y={yOf(maxY) + 10} className={styles.cap}>{d0(maxY)}</text>
      <text x={4} y={H - padB} className={styles.cap}>0</text>
      <text x={padL + 6} y={padT + 10} className={styles.cap}>
        Mbps if the direction owned the channel · solid = rover to base (video) · dashed = base to rover (control)
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- panels

function DirPanel({title, sub, dir, need, tag}) {
  const cls = !dir.up ? styles.bad : dir.linkAvail < 0.97 || dir.air > 0.6 ? styles.warn : styles.ok;
  return (
    <div className={`${styles.panel} ${cls}`}>
      <h5>{title} <small>{sub}</small></h5>
      <table className={styles.kv}>
        <tbody>
          <tr><td>Radio TX</td><td>{d1(dir.tx)} dBm <span className={styles.dim}>at MCS{dir.mcs}</span></td></tr>
          <tr>
            <td>EIRP</td>
            <td>
              {d1(dir.eirp)} dBm
              {dir.capped && <span className={styles.capTag}> capped from {d1(dir.eirpRaw)}</span>}
            </td>
          </tr>
          <tr><td>Received</td><td><b>{d1(dir.rx)} dBm</b></td></tr>
          <tr>
            <td>Usual rate</td>
            <td>
              {dir.up ? `MCS${dir.mcs} · ${d0(dir.phy)} Mbps` : 'none'}
              <span className={styles.dim}>
                {dir.up ? ` · held ${d0(dir.hold * 100)}%` : ` · MCS0 holds ${d0(dir.hold * 100)}%`}
              </span>
            </td>
          </tr>
          <tr>
            <td>Margin there</td>
            <td>{dir.margin >= 0 ? '+' : ''}{d1(dir.margin)} dB <span className={styles.dim}>vs {d0(dir.sens)}</span></td>
          </tr>
          <tr>
            <td>Link margin</td>
            <td><b>{dir.linkMargin >= 0 ? '+' : ''}{d1(dir.linkMargin)} dB</b>{' '}
              <span className={styles.dim}>before it drops</span></td>
          </tr>
          <tr>
            <td>Link uptime</td>
            <td style={dir.linkAvail < 0.97 ? {color: dir.linkAvail < 0.85 ? BAD : WARN} : undefined}>
              <b>{dir.linkAvail > 0.9995 ? '100' : d1(dir.linkAvail * 100)}%</b>{' '}
              <span className={styles.dim}>of the drive</span>
            </td>
          </tr>
          <tr><td>Capacity</td><td><b>{d1(dir.capacity)} Mbps</b> <span className={styles.dim}>alone on air</span></td></tr>
          <tr>
            <td>Airtime</td>
            <td style={dir.air > 0.6 ? {color: dir.air > 1 ? BAD : WARN} : undefined}>
              <b>{dir.air > 9.99 ? '—' : pct(dir.air)}</b>{' '}
              <span className={styles.dim}>for {need} Mbps {tag}</span>
            </td>
          </tr>
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
        Path loss starts as Friis in the usual engineering form,
        {' '}<code>FSPL = 20log₁₀(d_km) + 20log₁₀(f_MHz) + 32.44</code>, which is 108 dB at 1 km on
        5.8 GHz and 100 dB on 2.4 GHz. On top of that goes the <b>ground reflection</b>, because a
        mast this low never gets a clean free-space path. The direct ray and the ray bouncing off
        the dirt are summed coherently, with the phase flip that a grazing bounce always produces
        and a Rayleigh roughness term that keeps the nulls finite. Below the first maximum at
        {' '}<code>4·h₁·h₂/λ</code> the pair beats in and out, and past
        {' '}<code>4π·h₁·h₂/λ</code> the cancellation deepens until loss grows as d⁴ instead of d².
        That crossover is proportional to both antenna heights, which is the real reason mast
        height outruns antenna gain: at 5.8 GHz with a 3 m mast it sits near 875 m, and dropping
        the mast to 1 m pulls it in to under 300 m and costs you about 9 dB at 1 km for free.
      </p>
      <p>
        The first Fresnel zone is <code>√(λ·d₁·d₂ / D)</code>, and terrain poking into it is scored
        with the ITU-R P.526 single knife-edge approximation. That is why the 60% clearance rule
        falls out on its own: the diffraction parameter crosses <code>-0.78</code> at 0.55 of a
        Fresnel radius, and loss stops being zero from there. Once the ridge starts diffracting,
        the specular ground bounce has nothing left to reflect off, so the lab fades it out as the
        knife-edge loss climbs.
      </p>

      <h5>Putting it on real ground</h5>
      <p>
        The <b>Terrain</b> switch replaces the flat-desert-and-one-ridge world with a real
        heightmap: a 6 km square at 30 m resolution around either the Mars Desert Research Station
        or the Rolla test site, baked from USGS 3DEP via the AWS Terrain Tiles open dataset and
        committed to the repo so the page never depends on a live elevation API. Every value was
        spot-checked against the USGS <code>ned10m</code> service before it was written.
      </p>
      <p>
        On a map the mast heights become heights <i>above ground</i>, so a base parked in a wash is
        genuinely worse off than one on a rise, and the sector's off-boresight angle stops being a
        slider: it is the angle between where you aimed the antenna and where the rover actually
        is. The path profile is cut straight out of the heightmap with the 4/3 effective-earth
        bulge folded in, and multiple obstructions are scored with the <b>Deygout</b> construction
        — dominant edge first, then one subsidiary edge either side. Deygout over-predicts when
        several edges are of comparable height, which is why it stops at three rather than
        recursing.
      </p>
      <p>
        The ground reflection also gets more honest here. Its bounce plane is the least-squares fit
        through the actual profile, and the roughness that fills in the two-ray nulls is the real
        RMS departure of the ground from that plane rather than a fixed guess. That produces a
        result worth sitting with: <b>smooth ground is worse than broken ground</b> for the
        two-ray null, because broken ground scatters the specular ray away instead of returning it
        to cancel the direct one. Rolla's dissected Ozark terrain kills the reflection almost
        entirely and leaves you fighting diffraction; the flats around MDRS hand it right back.
        The caveat is that this uses whole-path RMS, which overstates roughness on terrain that is
        rolling but locally smooth — though by then diffraction dominates anyway.
      </p>

      <h5>Antennas, and what the band switch does to them</h5>
      <p>
        Antenna gain off boresight uses the standard main-lobe rolloff,
        {' '}<code>-12·(θ/θ₃dB)²</code>, floored at the sidelobe level. The base sector's gain and
        its two beamwidths are separate sliders on purpose, because the whole point is that they
        have to agree: <code>D ≈ 41253 / (H° × V°)</code> is the ceiling any real antenna obeys.
        A claimed gain above that ceiling is not achievable, so the lab quietly derates it to what
        the beamwidth can actually produce.
      </p>
      <p>
        The sliders describe the antenna <b>at 5.8 GHz</b>. An aperture keeps its physical size,
        not its beamwidth, so switching to 2.4 GHz stretches every beamwidth by the wavelength
        ratio of 2.38. A panel has two dimensions of aperture and gives up
        {' '}<code>20log₁₀(2.38) ≈ 7.5 dB</code>; a vertical omni has one and gives up
        {' '}<code>10log₁₀(2.38) ≈ 3.8 dB</code>. That is not a fudge, it is why the rover omni in
        the bill of materials is spec'd 6.7 dBi at 5 GHz and 3.6 at 2.4, and why an 18 dBi panel
        with a 20°×20° beam becomes a 12.6 dBi panel with a 48°×48° beam when you change bands.
        The upshot: 2.4 GHz buys you 7.5 dB of free-space loss and then hands most of it straight
        back in antenna gain, and the ground reflection does not care about frequency at all.
      </p>

      <h5>The rate ladder</h5>
      <p>
        Rates and sensitivities are the NetMetal ax datasheet: 802.11ax, two spatial streams, and a
        20 MHz sensitivity curve anchored on the three published points (-96 dBm at MCS0, -70 at
        MCS9, -67 at MCS11). Channel width scales the rate and moves the noise floor by
        {' '}<code>10log₁₀(BW/20)</code>, so every halving of bandwidth buys about 3 dB. External
        interference is added to thermal noise in linear power rather than in dB, so a jammer level
        with the noise floor costs 3 dB, not nothing. The radio also backs its own power off as the
        constellation gets denser, from its rated maximum at the bottom rung down 8 dB at MCS11.
      </p>
      <p>
        Sensitivity is a 10% packet error rate, not a promise. Real links fade, so the lab applies a
        log-normal fade of {SHADOW_SIGMA} dB sigma. Crucially the fade is <i>one</i> random variable
        that every rate sees at once, and when the top rung stops decoding the radio drops to the
        next one down rather than to zero. So throughput is averaged over the fade across the whole
        ladder — <code>Σ (phy[m] − phy[m−1]) × uptime(m)</code> — instead of being pinned to a single
        chosen rung. On a marginal link that fallback is most of the throughput.
      </p>
      <p>
        That is also why the panels separate two numbers that are easy to confuse. <b>Link uptime</b>
        is the bottom rung's availability: if MCS0 cannot be heard, nothing can, so this is the
        fraction of the drive you have a link at all. <b>Held</b> is how much of the drive the
        <i>usual</i> rate survives — a link can hold its top rate only 80% of the time and still be
        up 100% of the time, simply running a notch slower during the fades. Only the first one is
        a problem.
      </p>

      <h5>Airtime, because the channel is half duplex</h5>
      <p>
        One radio pair on one channel cannot send both ways at once, so the two directions share
        airtime rather than each getting their own. Each panel reports the capacity that direction
        would reach <i>alone on air</i>, and then the airtime its share of the mission actually
        costs: {CONTROL_FLOOR} Mbps of control downlink and {VIDEO_FLOOR} Mbps of video uplink. When
        those two demands add past 100% the mission does not fit, no matter how healthy the
        per-direction Mbps look on their own. That is the number to watch, not the headline rate.
      </p>

      <h5>The regulatory ceiling</h5>
      <p>
        Under Part 15 point-to-multipoint you give back 1 dB of conducted power for every 1 dB of
        antenna gain past 6 dBi, which pins EIRP at 36 dBm no matter what you bolt on the mast.
        Point-to-point is looser: 5.8 GHz hands you the gain for free and 2.4 GHz only takes back
        1 dB per 3. The cap is computed on peak gain, the way it gets measured, while the link uses
        the off-axis gain. Switching the mode to <i>ignore</i> is there to show you what the rules
        are costing you, not as an operating suggestion. TX power sliders stop at the radio's own
        rated maximum for the band, 28 dBm on 5 GHz and 30 on 2.4.
      </p>

      <h5>What it still simplifies</h5>
      <ul>
        <li>MAC overhead is a flat {Math.round(MAC_EFFICIENCY * 100)}% of PHY rate. Real 802.11ax
          efficiency moves with frame size and aggregation, and runs higher at low rates than high.</li>
        <li>One knife edge and one flat reflecting plane. Real desert is many soft edges and a
          reflector that is neither flat nor uniformly rough.</li>
        <li>The rover sits at ground level. There is no terrain elevation under it, so pitching the
          antenna toward the base only helps when the mast heights differ.</li>
        <li>No rain, no foliage, no polarization mismatch, and no earth curvature — the last one is
          worth under half a metre of bulge at 5 km, so it stays negligible at these ranges.</li>
        <li>The ACK-timeout penalty is a shaped guess, not a measurement. Real chipsets fail this
          more like a cliff than a ramp.</li>
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
  // Scenarios reset the radio, not where you have put yourself on the map.
  const preset = (patch) =>
    setP((s) => ({
      ...DEFAULTS,
      site: s.site,
      baseE: s.baseE,
      baseN: s.baseN,
      aim: s.aim,
      heading: s.heading,
      ...patch,
    }));

  // Zoom, pan and layer choice are view state, not model parameters: they must
  // not re-run solve(), and they must not be reset by a scenario button.
  const [view, setView] = useState({cx: 500, cy: 500, z: 1, layer: 'sat'});
  const setSite = (v) => {
    setP((s) => ({...s, site: v}));
    setView((w) => ({...w, cx: 500, cy: 500, z: 1}));
  };
  const patch = (o) => setP((s) => ({...s, ...o}));
  const zoomBy = (f) =>
    setView((w) => {
      const z = clamp(w.z * f, 1, 8);
      const lim = 500 / z;
      return {...w, z, cx: clamp(w.cx, lim, 1000 - lim), cy: clamp(w.cy, lim, 1000 - lim)};
    });

  // Both radios and both channel widths are band-limited, so switching bands
  // has to drag any now-illegal setting back into range.
  const setBand = (v) =>
    setP((s) => ({
      ...s,
      band: v,
      width: BANDS[v].widths.includes(s.width) ? s.width : 40,
      baseTx: Math.min(s.baseTx, BANDS[v].txMax),
      roverTx: Math.min(s.roverTx, BANDS[v].txMax),
    }));

  const r = useMemo(() => solve(p, p.distance), [p]);
  const onMap = p.site !== 'off';
  const siteInfo = SITES.find((s) => s.id === p.site) || SITES[0];

  const sweep = useMemo(() => {
    // On a map the sweep stops where the real data does, rather than inventing
    // ground past the edge of the heightmap.
    const maxD =
      p.site === 'off'
        ? 5000
        : Math.max(300, Math.min(5000, Math.floor(distanceToEdge(p.baseE, p.baseN, p.heading) / 50) * 50));
    const rows = [];
    // Fine near the radio, because the ground-reflection nulls bunch up there.
    let linkRange = null;
    let videoRange = null;
    // A ridge sitting at a fixed distance puts the worst diffraction right
    // behind itself, so the honest answer is often "it drops here and comes
    // back" rather than a single clean range.
    let linkRecovers = false;
    let videoRecovers = false;
    for (let d = 25; d <= maxD; d += d < 400 ? 10 : 50) {
      const s = solve(p, d);
      rows.push({d, up: s.up.capacity, down: s.down.capacity});
      const linkOk = s.up.up && s.down.up;
      if (!linkOk && linkRange === null) linkRange = d;
      else if (linkOk && linkRange !== null) linkRecovers = true;
      if (!s.fits && videoRange === null) videoRange = d;
      else if (s.fits && videoRange !== null) videoRecovers = true;
    }
    return {
      maxD,
      rows,
      linkRange: linkRange === null ? maxD + 1 : linkRange,
      videoRange: videoRange === null ? maxD + 1 : videoRange,
      linkRecovers,
      videoRecovers,
    };
  }, [p]);

  // The sweep stops at 5 km. Saying "5.0 km" when the link never broke would
  // read like a computed answer instead of the edge of the chart.
  const range = (m) => (m > sweep.maxD ? `> ${d1(sweep.maxD / 1000)} km` : `${d1(m / 1000)} km`);

  const linkUp = r.up.up && r.down.up;
  const minAvail = Math.min(r.up.linkAvail, r.down.linkAvail);
  const minMargin = Math.min(r.up.linkMargin, r.down.linkMargin);
  const verdict = !linkUp
    ? {txt: `Link is down more often than not: even the bottom rate only holds ${d1(minAvail * 100)}% of the drive.`, cls: 'bad'}
    : r.airtime > 1
    ? {txt: `The mission does not fit. Video plus control needs ${pct(r.airtime)} of the airtime and you only have 100%.`, cls: 'bad'}
    : minAvail < 0.97
    ? {txt: `The link itself drops out ${d1((1 - minAvail) * 100)}% of the drive, on only ${d1(minMargin)} dB of margin. Buy margin before anything else.`, cls: 'warn'}
    : r.airtime > 0.7
    ? {txt: `It fits, but only just: ${pct(r.airtime)} of the airtime is already spoken for.`, cls: 'warn'}
    : {txt: `Video and control both fit in ${pct(r.airtime)} of the airtime, on ${d0(minMargin)} dB of link margin.`, cls: 'ok'};

  // Which direction to spend money on, and — the part that matters — whether
  // money can even help it. Gain on a capped transmitter buys you nothing.
  const upIsWorse = r.up.linkMargin <= r.down.linkMargin;
  const worseDir = upIsWorse ? r.up : r.down;
  const advice = upIsWorse
    ? 'rover to base. Base antenna gain buys margin here, because receive gain is not capped by Part 15.'
    : worseDir.capped
    ? 'base to rover — and more antenna gain will not fix it, because that transmitter is already pinned at the Part 15 ceiling. Mast height, cable loss and channel width are the levers.'
    : 'base to rover. It is not at the regulatory ceiling yet, so TX power and cable loss are still worth something.';

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
        <div className={styles.sceneMain}>
          <SideView p={p} r={r} />
          <div className={styles.mapRow}>
            {p.site === 'off' ? (
              <div className={styles.mapPrompt}>
                <b>Put this link on real ground</b>
                <span>
                  Load a USGS heightmap and the ridge sliders give way to actual terrain. Drag the
                  base station anywhere, swing the handle to aim the sector, and drag the rover to
                  set its bearing and range.
                </span>
                <div className={styles.pills}>
                  {SITES.map((s) => (
                    <button key={s.id} className={styles.pill} onClick={() => setSite(s.id)}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <>
                <div className={styles.mapBox}>
                  <div className={styles.mapStage}>
                    <MapView p={p} r={r} view={view} setView={setView} onChange={patch} />
                    <div className={styles.mapLayers}>
                      {[['sat', 'Satellite'], ['both', 'Both'], ['topo', 'Contours']].map(([v, txt]) => (
                        <button key={v} type="button"
                                className={`${styles.mapChip} ${view.layer === v ? styles.mapChipOn : ''}`}
                                aria-pressed={view.layer === v}
                                onClick={() => setView((w) => ({...w, layer: v}))}>
                          {txt}
                        </button>
                      ))}
                    </div>
                    <div className={styles.mapZoom}>
                      <button type="button" className={styles.mapChip} aria-label="Zoom in"
                              onClick={() => zoomBy(2)} disabled={view.z >= 8}>+</button>
                      <button type="button" className={styles.mapChip} aria-label="Zoom out"
                              onClick={() => zoomBy(0.5)} disabled={view.z <= 1}>−</button>
                      <button type="button" className={styles.mapChip} aria-label="Reset the view"
                              onClick={() => setView((w) => ({...w, cx: 500, cy: 500, z: 1}))}
                              disabled={view.z === 1 && view.cx === 500 && view.cy === 500}>⟲</button>
                    </div>
                  </div>
                  <p className={styles.mapHint}>
                    <b>{view.z}× zoom</b> · drag the map to pan, double-click to zoom in, drag the
                    square to move the base, the arrow to aim it, the circle to place the rover
                  </p>
                </div>
                <div className={styles.mapInfo}>
                  <h6>{siteInfo.name}</h6>
                  <p className={styles.mapSub}>{siteInfo.sub}</p>
                  <table className={styles.kv}>
                    <tbody>
                      <tr><td>Base ground</td><td><b>{d0(r.groundBase)} m</b></td></tr>
                      <tr><td>Rover ground</td><td>{d0(r.groundRover)} m</td></tr>
                      <tr>
                        <td>Rise to rover</td>
                        <td style={Math.abs(r.groundRover - r.groundBase) > 20 ? {color: WARN} : undefined}>
                          {r.groundRover - r.groundBase >= 0 ? '+' : ''}{d0(r.groundRover - r.groundBase)} m
                        </td>
                      </tr>
                      <tr>
                        <td>Worst clearance</td>
                        <td style={r.clearance < 0.6 ? {color: r.clearance < 0 ? BAD : WARN} : undefined}>
                          <b>{d0(r.clearance * 100)}%</b> of F1
                        </td>
                      </tr>
                      <tr>
                        <td>Pinched at</td>
                        <td>{r.ridgeInPath ? `${d0(r.pinchAt)} m out` : 'clear path'}</td>
                      </tr>
                      <tr><td>Ground roughness</td><td>{d1(r.refSigma)} m RMS</td></tr>
                      <tr><td>Off boresight</td><td>{d0(r.bearingOff)}°</td></tr>
                      <tr><td>Heading</td><td>{d0(p.heading)}° · {d0(r.D)} m</td></tr>
                    </tbody>
                  </table>
                  <p className={styles.mapAttr}>
                    {siteInfo.lat.toFixed(4)}, {siteInfo.lon.toFixed(4)} · {siteInfo.min}–{siteInfo.max} m ·
                    elevation 30 m from USGS 3DEP, imagery 3.75 m from USGS National Map
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
        <div className={styles.sceneSide}>
          <TopView p={p} r={r} />
          <PatternView p={p} r={r} />
        </div>
      </div>

      <div className={`${styles.verdict} ${styles[verdict.cls]}`}>{verdict.txt}</div>

      <div className={styles.panels}>
        <DirPanel
          title="Base → rover" sub="the joystick" dir={r.down}
          need={CONTROL_FLOOR} tag="of control"
        />
        <DirPanel
          title="Rover → base" sub="the cameras" dir={r.up}
          need={VIDEO_FLOOR} tag="of video"
        />
        <div className={styles.panel}>
          <h5>The path <small>shared by both</small></h5>
          <table className={styles.kv}>
            <tbody>
              <tr><td>Free space loss</td><td>{d1(r.fsplDb)} dB</td></tr>
              <tr>
                <td>Ground bounce</td>
                <td style={r.ground > 3 ? {color: WARN} : undefined}>
                  {r.ground >= 0 ? '+' : ''}{d1(r.ground)} dB
                </td>
              </tr>
              <tr>
                <td>Obstruction</td>
                <td>{r.obstruction > 0.05 ? <b>{d1(r.obstruction)} dB</b> : 'none'}</td>
              </tr>
              <tr><td>Total path loss</td><td><b>{d1(r.pathLoss)} dB</b></td></tr>
              <tr><td>Fresnel radius</td><td>{d1(r.f1Mid)} m at midpoint</td></tr>
              <tr>
                <td>Clearance</td>
                <td>{r.ridgeInPath ? `${d0(r.clearance * 100)}% of F1 at the ridge` : 'nothing in the way'}</td>
              </tr>
              <tr>
                <td>Airtime used</td>
                <td style={r.airtime > 0.7 ? {color: r.airtime > 1 ? BAD : WARN} : undefined}>
                  <b>{r.airtime > 9.99 ? 'over 1000%' : pct(r.airtime)}</b>
                </td>
              </tr>
              <tr>
                <td>Link first drops at</td>
                <td>
                  <b>{range(sweep.linkRange)}</b>
                  {sweep.linkRecovers && <span className={styles.dim}> then recovers</span>}
                </td>
              </tr>
              <tr>
                <td>Video first drops at</td>
                <td>
                  <b>{range(sweep.videoRange)}</b>
                  {sweep.videoRecovers && <span className={styles.dim}> then recovers</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <RangeChart sweep={sweep} r={r} />

      <p className={styles.hintLine}>
        The tighter direction right now is <b>{advice}</b>
      </p>

      <div className={styles.controls}>
        <div className={styles.group}>
          <h6>Geometry</h6>
          <Slider label="Distance" value={p.distance} min={50} max={2500} step={25} unit=" m" onChange={set('distance')} />
          <Slider label="Base mast height" value={p.baseH} min={1} max={12} step={0.5} unit=" m" onChange={set('baseH')}
                  hint="the single most powerful knob on this page" />
          <Slider label="Rover antenna height" value={p.roverH} min={0.2} max={3} step={0.1} unit=" m" onChange={set('roverH')} />
          <Slider label="Ridge height" value={p.ridgeH} min={0} max={20} step={0.5} unit=" m" onChange={set('ridgeH')}
                  disabled={onMap}
                  hint={onMap ? 'real terrain is driving the path instead' : '0 means clear desert'} />
          <Slider label="Ridge distance from base" value={p.ridgeD} min={25} max={2500} step={25} unit=" m"
                  onChange={set('ridgeD')} disabled={onMap || p.ridgeH === 0}
                  hint={!onMap && p.ridgeH > 0 && !r.ridgeInPath ? 'past the rover, so nothing is in the way' : null} />
        </div>

        <div className={styles.group}>
          <h6>Base station</h6>
          <Slider label="TX power" value={p.baseTx} min={5} max={BANDS[p.band].txMax} step={1} unit=" dBm"
                  onChange={set('baseTx')} hint={`radio maxes out at ${BANDS[p.band].txMax} dBm on ${BANDS[p.band].label}`} />
          <Slider label="Claimed gain at 5.8" value={p.baseGain} min={3} max={27} step={0.5} unit=" dBi" onChange={set('baseGain')}
                  hint={<SpecCheck claimed={p.baseGain} implied={r.impliedRef} />} />
          <Slider label="Azimuth beamwidth at 5.8" value={p.baseHBeam} min={8} max={120} step={2} unit="°" onChange={set('baseHBeam')} />
          <Slider label="Elevation beamwidth at 5.8" value={p.baseVBeam} min={4} max={90} step={1} unit="°" onChange={set('baseVBeam')}
                  hint={p.band === '2.4'
                    ? `on 2.4 GHz the same aperture is ${d0(r.hBase)}°×${d0(r.vBase)}° and ${d1(r.baseGain)} dBi`
                    : null} />
          <Slider label="Rover off boresight" value={onMap ? d0(r.bearingOff) : p.bearing}
                  min={0} max={90} step={1} unit="°" onChange={set('bearing')} disabled={onMap}
                  hint={onMap ? 'set by where the sector is aimed vs where the rover is' : null} />
          <Slider label="Mechanical downtilt" value={p.downtilt} min={0} max={15} step={1} unit="°" onChange={set('downtilt')} />
          <Slider label="Coax loss" value={p.baseCable} min={0} max={20} step={0.2} unit=" dB" onChange={set('baseCable')}
                  hint="1 m LMR-240 ≈ 0.4 · 25 m LMR-400 ≈ 18" />
        </div>

        <div className={styles.group}>
          <h6>Rover</h6>
          <Slider label="TX power" value={p.roverTx} min={5} max={BANDS[p.band].txMax} step={1} unit=" dBm" onChange={set('roverTx')} />
          <Slider label="Antenna gain at 5.8" value={p.roverGain} min={2} max={12} step={0.1} unit=" dBi" onChange={set('roverGain')}
                  hint={p.band === '2.4'
                    ? `${d1(r.roverGain)} dBi on 2.4 GHz · toroid is ${d1(r.vRover)}° tall`
                    : `toroid is ${d1(r.vRover)}° tall`} />
          <Slider label="Pitch on the slope" value={p.tilt} min={-45} max={45} step={1} unit="°" onChange={set('tilt')}
                  hint="negative pitches the toroid toward the base" />
          <Slider label="Pigtail loss" value={p.roverCable} min={0} max={4} step={0.1} unit=" dB" onChange={set('roverCable')} />
        </div>

        <div className={styles.group}>
          <h6>Channel and rules</h6>
          <Pills label="Band" value={p.band} options={[['2.4', '2.4 GHz'], ['5.8', '5.8 GHz']]} onChange={setBand} />
          <Pills label="Channel width" value={p.width}
                 options={BANDS[p.band].widths.map((v, i, a) => [v, i === a.length - 1 ? `${v} MHz` : String(v)])}
                 onChange={set('width')} />
          <Pills label="Part 15 mode" value={p.reg}
                 options={[['ptmp', 'multipoint'], ['p2p', 'point to point'], ['off', 'ignore']]} onChange={set('reg')} />
          <Slider label="Interference vs thermal" value={p.interference} min={-20} max={25} step={1} unit=" dB"
                  onChange={set('interference')}
                  hint={`noise floor up ${d1(10 * log10(1 + dbToLin(p.interference)))} dB · competition day is +10 to +15`} />
          <label className={styles.check}>
            <input type="checkbox" checked={p.ackSet} onChange={() => set('ackSet')(!p.ackSet)} />
            <span>ACK timeout set for the link length</span>
          </label>
        </div>

        <div className={styles.group}>
          <h6>Ground truth</h6>
          <Pills
            label="Terrain"
            value={p.site}
            options={[['off', 'flat + ridge'], ...SITES.map((s) => [s.id, s.id === 'mdrs' ? 'MDRS' : 'Rolla'])]}
            onChange={setSite}
          />
          <Slider label="Sector aim" value={p.aim} min={0} max={359} step={1} unit="° from N"
                  onChange={set('aim')} disabled={!onMap}
                  hint={onMap ? 'or drag the handle on the map' : 'pick a site to enable'} />
          <Slider label="Rover heading" value={p.heading} min={0} max={359} step={1} unit="° from N"
                  onChange={set('heading')} disabled={!onMap}
                  hint={onMap ? 'or drag the rover on the map' : null} />
          <Slider label="Base east of centre" value={p.baseE} min={-2900} max={2900} step={25} unit=" m"
                  onChange={set('baseE')} disabled={!onMap} />
          <Slider label="Base north of centre" value={p.baseN} min={-2900} max={2900} step={25} unit=" m"
                  onChange={set('baseN')} disabled={!onMap} />
        </div>
      </div>
    </div>
  );
}
