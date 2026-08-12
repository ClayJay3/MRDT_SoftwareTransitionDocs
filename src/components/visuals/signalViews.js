import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import useBaseUrl from '@docusaurus/useBaseUrl';
import styles from './signalViews.module.css';
import {HELP} from './signalHelp';
import {SITES, SPAN_M, contourBands, gridIsFine, loadFineGrid} from './terrainModel';
import {
  BANDS,
  CONTROL_FLOOR,
  MAC_EFFICIENCY,
  SHADOW_SIGMA,
  VIDEO_FLOOR,
  clamp,
  fresnel,
  rolloff,
} from './signalModel';

// Every view the link lab draws, shared by the doc-page embed (SignalLab) and
// the full-page studio (SignalStudio). All of the physics lives in
// signalModel.js; everything here is presentation, inline SVG and pointer
// handling, so the two pages cannot drift apart on what a number means.
// SSR-safe: no browser APIs outside event handlers.

export const OK = '#4caf50';
export const WARN = '#e5a73c';
export const BAD = '#e06c75';

// The two directions get their own colours everywhere they appear — chart,
// panel headers, legends — because "solid vs dashed" was doing all the work and
// the dashed one happened to land on the same red as the failure markers.
export const VIDEO = '#4caf50'; // rover → base, the cameras
export const CONTROL = '#4c9be8'; // base → rover, the joystick

// ---------------------------------------------------------------- widgets

// A "?" badge that explains one number. The bubble is position:fixed and placed
// from the badge's own rect, because every one of these lives inside a rail
// that scrolls — an absolutely positioned tooltip would be clipped by it.
// Hover, focus and click all open it, so it works from a keyboard and on touch.
//
// It is rendered into the body rather than next to the badge, and that is not a
// nicety. `position: fixed` means "relative to the viewport" only until some
// ancestor becomes a containing block for fixed descendants, which a non-none
// backdrop-filter does — and every card in the studio is frosted glass over the
// map. Left where it was written, the bubble took its viewport coordinates and
// had the card's own corner added to them, landing it a full panel away from
// the badge it belonged to.
export function Help({id}) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  const tipId = useId();
  const entry = HELP[id];

  const place = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // The bubble is sized in the page's own scaling unit, and on the studio that
    // unit tracks the viewport. Recover it from the badge itself, which is
    // exactly 0.92 of it: reading the custom property back gives an unresolved
    // clamp() rather than a length.
    const u = r.width / 0.92 || 16;
    const half = (19 * u) / 2;
    const below = window.innerHeight - r.bottom > 12 * u;
    setTip({
      u,
      x: Math.min(Math.max(r.left + r.width / 2, half + 6), window.innerWidth - half - 6),
      y: below ? r.bottom + 6 : r.top - 6,
      below,
    });
  };
  const hide = () => setTip(null);

  // The placement is a snapshot of where the badge was. Anything that moves it
  // afterwards — the left rail scrolling under the pointer, a window resize —
  // would strand the bubble, so it closes instead of lying about what it points
  // at. Capture phase, because the rail scrolls, not the window.
  useEffect(() => {
    if (!tip) return undefined;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [tip]);

  if (!entry) return null;
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.help}
        aria-label={`What is ${entry.title}?`}
        aria-describedby={tip ? tipId : undefined}
        onMouseEnter={place}
        onMouseLeave={hide}
        onFocus={place}
        onBlur={hide}
        onClick={(e) => {
          e.preventDefault();
          if (tip) hide();
          else place();
        }}
      >
        ?
      </button>
      {tip &&
        createPortal(
          <span
            id={tipId}
            role="tooltip"
            className={`${styles.tip} ${tip.below ? '' : styles.tipAbove}`}
            // Out in the body the bubble is no longer inside whatever set the
            // page's scaling unit, so it carries the one it was measured in.
            style={{left: `${tip.x}px`, top: `${tip.y}px`, '--sl-u': `${tip.u}px`}}
          >
            <b>{entry.title}</b>
            {entry.text}
          </span>,
          document.body,
        )}
    </>
  );
}

// Legends live in HTML rather than inside the SVG on purpose: SVG text scales
// with the box the drawing is rendered into, so a legend drawn in the chart
// would be tiny in a narrow column and enormous in a wide one.
export function Legend({items}) {
  return (
    <ul className={styles.legend}>
      {items.filter(Boolean).map(([kind, color, label, help]) => (
        <li key={label}>
          <svg viewBox="0 0 22 10" className={styles.swatch} aria-hidden="true">
            {kind === 'area' ? (
              <rect x="1" y="2" width="20" height="6" rx="1"
                    fill={color} fillOpacity="0.28" stroke={color} strokeWidth="1" />
            ) : (
              <line x1="1" y1="5" x2="21" y2="5" stroke={color}
                    strokeWidth={kind === 'thick' ? 3.5 : 2.5}
                    strokeDasharray={kind === 'dashed' ? '5 3' : kind === 'dotted' ? '2 2.5' : undefined} />
            )}
          </svg>
          <span>{label}</span>
          {help && <Help id={help} />}
        </li>
      ))}
    </ul>
  );
}

// An SVG and the legend that explains it, kept together so no page can render
// one without the other.
function Figure({children, items, note}) {
  return (
    <div className={styles.figure}>
      {children}
      {note && <p className={styles.figNote}>{note}</p>}
      <Legend items={items} />
    </div>
  );
}

export function Slider({label, value, min, max, step, unit, onChange, hint, disabled, help}) {
  return (
    <label className={`${styles.ctl} ${disabled ? styles.ctlOff : ''}`}>
      <span className={styles.ctlTop}>
        <span>{label}{help && <Help id={help} />}</span>
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

export function Pills({label, value, options, onChange, help}) {
  return (
    <div className={styles.ctl}>
      <span className={styles.ctlTop}><span>{label}{help && <Help id={help} />}</span></span>
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

export const d1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
export const d0 = (x) => Math.round(x);
export const pct = (x) => `${Math.round(clamp(x, 0, 9.99) * 100)}%`;

// D ≈ 41253 / (H° × V°). If the claimed gain doesn't agree with the claimed
// beamwidth, one of the two numbers is fiction. This is the cheapest way to
// catch a marketplace listing that has been sexed up by 5 dB. Always judged at
// 5.8 GHz, because that is what the sliders describe.
export function SpecCheck({claimed, implied}) {
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

export function SideView({p, r}) {
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
    <Figure
      items={[
        ['thick', health, 'line of sight', 'legendLos'],
        ['area', 'var(--sl-accent)', 'first Fresnel zone', 'legendFresnel'],
        ['dashed', WARN, 'ground bounce', 'legendBounce'],
        ['area', 'var(--ifm-color-emphasis-500)', 'terrain', 'legendTerrain'],
        r.ridgeInPath && ['dotted', BAD, 'worst clearance', 'legendPinch'],
      ]}
    >
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
    </Figure>
  );
}

// ---------------------------------------------------------------- map view

const compass = (de, dn) => ((Math.atan2(de, dn) * 180) / Math.PI + 360) % 360;
const MAP_S = 1000; // the map's own unit square
const MAX_Z = 8;

// ------------------------------------------------------- the fine heightmap
//
// The bundled grid is 30 m a sample so that it can live in the JS bundle and
// render on the server. The real one is 11.7 m — 3DEP's own resolution — and is
// a plain file the browser fetches once and caches. Nothing waits for it: the
// page draws on the coarse grid, the fine one lands, and the returned revision
// changes so whoever is holding a memoised solve() knows to run it again.
export function useFineTerrain(siteId) {
  const [rev, setRev] = useState(0);
  const site = SITES.find((s) => s.id === siteId);
  // Hooks cannot be conditional, and useBaseUrl is the only thing that knows
  // where this site is deployed, so it is always called and the miss is handled
  // downstream by loadFineGrid refusing a site it does not have.
  const url = useBaseUrl(site?.fine || 'data/terrain/');
  useEffect(() => {
    if (!site) return undefined;
    let alive = true;
    loadFineGrid(siteId, url).then((ok) => {
      if (ok && alive) setRev((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [siteId, url, site]);
  // Not the revision itself: a site that was already fine before this component
  // mounted installs nothing and would otherwise report as coarse forever.
  return {rev, fine: Boolean(site) && gridIsFine(siteId)};
}

// ---------------------------------------------------------- imagery tiles
//
// The baked WebP under the map is one file covering the whole 6 km window, which
// makes it 2.9 m per pixel — fine at 1x, mush at 8x. Past 1x the map lays live
// USGS National Map tiles over it, picking the zoom level that matches what is
// actually on screen and drawing only the tiles the viewBox touches.
//
// The tiles are public domain, need no key, send Access-Control-Allow-Origin and
// are cached for a day, so the second look at a patch of ground costs nothing.
// The baked image stays underneath as the floor: with no network, a blocked
// request or a site outside NAIP coverage, the map still draws.
//
// z16 is the ceiling because it is where USGS stops caching — z17 and up 404,
// and rendering them out of the export endpoint returns visibly interpolated
// NAIP with must-revalidate headers. Nothing above 16 is real detail.
const TILE_URL =
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile';
const TILE_Z_MIN = 12;
const TILE_Z_MAX = 16;
// Enough to cover a wide window with a level in hand; past this the level steps
// back rather than the map mounting hundreds of <image> nodes.
const TILE_BUDGET = 96;

const tileLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;
const tileLat = (y, z) => {
  const t = Math.PI * (1 - (2 * y) / Math.pow(2, z));
  return (180 / Math.PI) * Math.atan(Math.sinh(t));
};

// Ground resolution of one tile pixel, metres, at this latitude.
const tileMetresPerPx = (z, lat) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);

// Which tiles cover the visible box, in the map's own 0..1000 units.
//
// Tiles are Web Mercator and the map is a local east/north plane, so each tile
// is placed from its own corners through the same linear lat/lon-to-metres
// conversion the bake used. Over a 6 km window the two projections differ by
// well under a pixel, and doing it per tile means the error cannot accumulate.
function visibleTiles(site, mPerPx, x0, y0, x1, y1) {
  const toU = (lon, lat) => {
    const east = (lon - site.lon) * 111320 * Math.cos((site.lat * Math.PI) / 180);
    const north = (lat - site.lat) * 111320;
    return [((east + SPAN_M / 2) / SPAN_M) * MAP_S, ((SPAN_M / 2 - north) / SPAN_M) * MAP_S];
  };

  let z = TILE_Z_MIN;
  while (z < TILE_Z_MAX && tileMetresPerPx(z, site.lat) > mPerPx) z++;

  for (; z >= TILE_Z_MIN; z--) {
    const n = Math.pow(2, z);
    // The window's own lon/lat span, widened to the map edges we can see.
    const lonOf = (u) =>
      site.lon +
      ((u / MAP_S - 0.5) * SPAN_M) / (111320 * Math.cos((site.lat * Math.PI) / 180));
    const latOf = (u) => site.lat + ((0.5 - u / MAP_S) * SPAN_M) / 111320;

    const tx = (lon) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
    };

    const cx0 = tx(lonOf(x0));
    const cx1 = tx(lonOf(x1));
    const cy0 = ty(latOf(y0));
    const cy1 = ty(latOf(y1));
    const count = (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    if (count > TILE_BUDGET && z > TILE_Z_MIN) continue;

    const out = [];
    for (let ty2 = cy0; ty2 <= cy1; ty2++) {
      for (let tx2 = cx0; tx2 <= cx1; tx2++) {
        if (tx2 < 0 || ty2 < 0 || tx2 >= n || ty2 >= n) continue;
        const [ax, ay] = toU(tileLon(tx2, z), tileLat(ty2, z));
        const [bx2, by2] = toU(tileLon(tx2 + 1, z), tileLat(ty2 + 1, z));
        out.push({
          key: `${z}/${tx2}/${ty2}`,
          // ArcGIS orders the path z/y/x, unlike every slippy map convention.
          href: `${TILE_URL}/${z}/${ty2}/${tx2}`,
          x: ax,
          y: ay,
          w: bx2 - ax,
          h: by2 - ay,
        });
      }
    }
    return {z, tiles: out};
  }
  return {z: TILE_Z_MIN, tiles: []};
}

// One <image> that removes itself if the tile does not arrive, so a gap in NAIP
// coverage or a blocked request shows the baked imagery underneath rather than a
// broken-image icon. There is no cache to keep here: the tiles come back with a
// day of max-age and the browser is better at that than we would be.
function Tile({href, x, y, w, h}) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <image
      href={href}
      x={x}
      y={y}
      width={w}
      height={h}
      preserveAspectRatio="none"
      onError={() => setFailed(true)}
    />
  );
}

// Top-down USGS orthoimagery and terrain for the chosen site. Drag the base
// anywhere, swing the aim handle to point the sector, and drag the rover to set
// both the heading and the range. Drag the background to pan; the buttons and a
// double-click zoom. Everything the propagation model needs is read off this.
// Keep a view inside the heightmap. The visible span is square only when the
// box is: the map is scaled to cover, so the box's long axis shows the whole
// span and its short axis shows less. Which axis that is depends on the shape
// of the window, and clamping both as though the box were always landscape
// pinned the pan on the one axis that actually had room to move.
// How much of the window may be dragged out past the edge of the heightmap.
// Without it a square map covering an oblong window is pinned on its long axis
// the moment it fits — at 1x on a wide screen the full 6 km width is on screen
// and a sideways drag has nowhere to go, which reads as a broken map rather
// than as the edge of the data. A third means you can always shove the terrain
// aside to see what is hiding under the instruments, and never so far that you
// lose the map: two thirds of the window is still ground at the stop.
export const OVER_PAN = 1 / 3;

// Keep a view inside the heightmap. The visible span is square only when the
// box is: the map is scaled to cover, so the box's long axis shows the whole
// span and its short axis shows less. Which axis that is depends on the shape
// of the window, and clamping both as though the box were always landscape
// pinned the pan on the one axis that actually had room to move.
export function clampMapView(cx, cy, z, ar = 1, over = 0) {
  const half = MAP_S / (2 * z);
  const axis = (v, h) => {
    // Room to run past the edge, in map units, from the position where that
    // edge sits exactly on the frame. The two guards keep the range from
    // inverting once the window is showing more map than exists.
    const edge = h * (1 - 2 * over);
    return clamp(v, Math.min(edge, MAP_S / 2), Math.max(MAP_S - edge, MAP_S / 2));
  };
  return {z, cx: axis(cx, half * Math.min(1, ar)), cy: axis(cy, half / Math.max(1, ar))};
}

// How far the view can still travel on each axis, in map units, so the page can
// name the directions that actually go somewhere instead of promising a drag it
// cannot honour.
export function panRoom(z, ar = 1, over = 0) {
  const half = MAP_S / (2 * z);
  const room = (h) => {
    const edge = h * (1 - 2 * over);
    return Math.max(MAP_S - edge, MAP_S / 2) - Math.min(edge, MAP_S / 2);
  };
  return {x: room(half * Math.min(1, ar)), y: room(half / Math.max(1, ar))};
}

// `cover` lets the map fill a box of any shape, the way a background image
// would: z = 1 shows the full 6 km width and the height follows the box. Left
// off — as the doc page leaves it — the box is square and this is exactly the
// square view it always was.
export function MapView({p, r, view, setView, onChange, cover, chrome = 1, onAspect}) {
  const drag = useRef(null);
  const svgRef = useRef(null);
  const [box, setBox] = useState({w: MAP_S, h: MAP_S});
  // What the pointer currently has hold of, purely so the cursor can say so.
  const [grab, setGrab] = useState(null);
  const site = SITES.find((s) => s.id === p.site) || SITES[0];
  const imgSrc = useBaseUrl(site.image);
  // The contours are cut from whichever heightmap is loaded, so they have to be
  // re-cut when the fine one lands — otherwise the map keeps drawing 30 m
  // terrain under a model that has moved on to 11.7 m.
  const {rev: terrainRev} = useFineTerrain(p.site);
  const bands = useMemo(() => contourBands(p.site), [p.site, terrainRev]);

  // The viewBox has to match the element's shape or the pointer maths — and the
  // picture — go wrong, so the element measures itself. Measured in both
  // layouts, not just the full-bleed one: the tile layer needs to know how many
  // screen pixels a metre is getting before it can pick a zoom level, and that
  // is a question about the element, not about the aspect ratio.
  useEffect(() => {
    const el = svgRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) setBox({w: b.width, h: b.height});
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ar = cover && box.h > 0 ? box.w / box.h : 1;
  useEffect(() => {
    if (onAspect) onAspect(ar);
  }, [ar, onAspect]);

  // Half the visible span on each axis, in map units — the same split as the
  // pan clamp, since they have to agree about what is on screen. halfV is the
  // viewBox's own half-span; the visible pair is what covering the box leaves.
  // Everything on screen that should keep a constant size gets multiplied by k
  // to undo the zoom.
  const halfV = MAP_S / (2 * view.z);
  const halfW = halfV * Math.min(1, ar);
  const halfH = halfV / Math.max(1, ar);
  const k = chrome / view.z;

  const xOf = (e) => ((e + SPAN_M / 2) / SPAN_M) * MAP_S;
  const yOf = (n) => ((SPAN_M / 2 - n) / SPAN_M) * MAP_S;
  const unitToM = (u) => (u / MAP_S) * SPAN_M;

  const bx = xOf(p.baseE);
  const by = yOf(p.baseN);
  const rx = xOf(r.roverE);
  const ry = yOf(r.roverN);

  // The aim handle sits at a constant distance on screen, not on the ground, so
  // it stays reachable at every zoom level — measured against the tighter of the
  // two visible spans, or on a window that is much wider than it is tall the
  // handle is thrown off the top or bottom edge and cannot be grabbed at all.
  const aimR = unitToM(Math.min(halfW, halfH) * 0.34);
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
    const rect = ev.currentTarget.getBoundingClientRect();
    const scale = cover
      ? Math.max(rect.width / (2 * halfV), rect.height / (2 * halfV))
      : rect.width / (2 * halfV);
    const ux = view.cx + (ev.clientX - rect.left - rect.width / 2) / scale;
    const uy = view.cy + (ev.clientY - rect.top - rect.height / 2) / scale;
    return {
      ux, uy,
      e: (ux / MAP_S - 0.5) * SPAN_M,
      n: (0.5 - uy / MAP_S) * SPAN_M,
      unitsPerPx: 1 / Math.max(scale, 1e-6),
    };
  }

  // Only the full-bleed map is free to be shoved past its own edge. In a doc
  // column the map is a figure that shows the whole site at 1x, and sliding it
  // off centre there would just look broken.
  const clampView = (cx, cy, z) => clampMapView(cx, cy, z, ar, cover ? OVER_PAN : 0);

  // Zoom about a fixed point, so the ground under the cursor stays put:
  //   cx' = cx + (ux - cx) * (1 - z/z')
  const zoomBy = (factor, ux, uy) =>
    setView((v) => {
      const nz = clamp(v.z * factor, 1, MAX_Z);
      // Already against the stop. Returning v unchanged rather than an equal
      // copy matters on the wheel, which fires a stream of these: a new object
      // every notch would re-render the whole map for no visible reason.
      if (nz === v.z) return v;
      const f = 1 - v.z / nz;
      return {...clampView(v.cx + (ux - v.cx) * f, v.cy + (uy - v.cy) * f, nz), layer: v.layer};
    });

  function onDown(ev) {
    // Right and middle buttons belong to the browser. A fresh press always
    // replaces whatever was in flight rather than being refused: if a drag ever
    // did latch on — a swallowed pointerup, a cancelled gesture — refusing here
    // would leave the map dead for the rest of the session, which is the worst
    // failure this thing has.
    if (ev.button !== 0) return;
    const m = locate(ev);
    // A handle is about 21 px across on screen at every zoom, so the grab
    // radius has to be a comfortable margin outside that rather than level
    // with its edge.
    const tol = unitToM(m.unitsPerPx * 26);
    const near = [
      ['rover', Math.hypot(m.e - r.roverE, m.n - r.roverN)],
      ['aim', Math.hypot(m.e - aimE, m.n - aimN)],
      ['base', Math.hypot(m.e - p.baseE, m.n - p.baseN)],
    ].filter(([, d]) => d < tol).sort((a, b) => a[1] - b[1])[0];

    drag.current = near
      ? {mode: near[0], id: ev.pointerId}
      : {mode: 'pan', id: ev.pointerId, x0: ev.clientX, y0: ev.clientY,
         cx0: view.cx, cy0: view.cy, scale: m.unitsPerPx};
    setGrab(near ? near[0] : 'pan');
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }

  function onMove(ev) {
    const d = drag.current;
    if (!d || d.id !== ev.pointerId) return;
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

  // Also wired to lostpointercapture, because a capture torn away by anything
  // other than a clean release — the browser cancelling the gesture, a
  // re-render replacing the node — would otherwise leave a drag latched on with
  // no button held, and the next press would go to the ghost instead of the
  // handle under the cursor.
  function onUp(ev) {
    if (drag.current && drag.current.id !== ev.pointerId) return;
    drag.current = null;
    setGrab(null);
    if (ev.currentTarget.hasPointerCapture?.(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  }

  function onDoubleClick(ev) {
    const m = locate(ev);
    zoomBy(2, m.ux, m.uy);
  }

  // --- the wheel
  //
  // Filling the window, the map IS the page and the wheel is the zoom. Sitting
  // in a doc column it is not: a map that eats the wheel traps a reader trying
  // to scroll past it, so there it wants Ctrl (or ⌘) held, which is the same
  // bargain every embedded map on the web makes.
  const wheelZooms = (ev) => Boolean(cover) || ev.ctrlKey || ev.metaKey;

  function onWheel(ev) {
    if (!wheelZooms(ev)) return; // let the page scroll
    // Only now, because preventDefault on a gesture we are not handling is how
    // a page stops scrolling for no visible reason.
    ev.preventDefault();
    // A mouse notch is ~100 px of deltaY, a trackpad sends a stream of small
    // ones, and Firefox may bill either in lines or in pages instead.
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? box.h || MAP_S : 1;
    // Exponential, so a notch is a constant ratio wherever you already are and
    // zooming out undoes zooming in exactly.
    const factor = Math.exp((-ev.deltaY * unit) / 340);
    const m = locate(ev);
    zoomBy(factor, m.ux, m.uy);
  }

  // The listener has to be native and non-passive: React routes wheel events
  // through a passive root listener, where preventDefault is a no-op and the
  // page scrolls anyway. Registered once and pointed at a ref, so it always runs
  // the current closure without tearing the listener down on every pan.
  const wheelRef = useRef(null);
  useEffect(() => {
    wheelRef.current = onWheel;
  });
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const h = (ev) => wheelRef.current?.(ev);
    el.addEventListener('wheel', h, {passive: false});
    return () => el.removeEventListener('wheel', h);
  }, []);

  // --- the imagery on top of the baked fallback

  const mPerPx = unitToM(2 * halfW) / Math.max(box.w, 1);
  const tiling = useMemo(
    () =>
      visibleTiles(
        site,
        mPerPx,
        clamp(view.cx - halfW, 0, MAP_S),
        clamp(view.cy - halfH, 0, MAP_S),
        clamp(view.cx + halfW, 0, MAP_S),
        clamp(view.cy + halfH, 0, MAP_S),
      ),
    [site, mPerPx, view.cx, view.cy, halfW, halfH],
  );

  // --- chrome that must stay a constant size on screen

  // Pick a scale bar that lands near a third of the visible width.
  const visibleM = unitToM(2 * halfW);
  const barM = [2000, 1000, 500, 200, 100, 50].find((v) => v <= visibleM * 0.38) || 50;
  const barU = (barM / SPAN_M) * MAP_S;
  const vx0 = view.cx - halfW;
  const vy0 = view.cy - halfH;
  const pad = 26 * k;

  const rings = [500, 1000, 2000, 4000].filter((d) => d <= SPAN_M);

  return (
    <svg ref={svgRef}
         viewBox={`${view.cx - halfV} ${view.cy - halfV} ${2 * halfV} ${2 * halfV}`}
         preserveAspectRatio={cover ? 'xMidYMid slice' : undefined}
         className={`${styles.svg} ${styles.map} ${cover ? styles.mapCover : ''} ${
           grab ? styles.mapGrabbing : ''
         }`}
         onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
         onLostPointerCapture={onUp}
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

        {/* The baked 6 km WebP is the floor: it is what renders before any tile
            arrives, offline, and anywhere NAIP does not reach. The live tiles
            lie on top of it at whatever level matches the screen. */}
        {view.layer !== 'topo' && (
          <image href={imgSrc} x="0" y="0" width={MAP_S} height={MAP_S}
                 preserveAspectRatio="none" />
        )}
        {view.layer !== 'topo' &&
          tiling.tiles.map((t) => (
            <Tile key={t.key} href={t.href} x={t.x} y={t.y} w={t.w} h={t.h} />
          ))}
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
        {/* The three handles. Each carries a transparent disc a good deal wider
            than the marker it draws, which does nothing for the hit test — that
            is proximity, not geometry — but everything for the cursor, which is
            how you find out they can be dragged at all. */}
        <g className={styles.handle} transform={`translate(${ax} ${ay}) scale(${k})`}>
          <circle cx="0" cy="0" r="20" fill="transparent" />
          <circle cx="0" cy="0" r="11" fill="#fff" fillOpacity="0.92" stroke="#000" strokeOpacity="0.5" strokeWidth="1.5" />
          <path d="M-4,3 L0,-5 L4,3 Z" fill="#000" fillOpacity="0.72" transform={`rotate(${p.aim})`} />
        </g>

        <g className={styles.handle} transform={`translate(${bx} ${by}) scale(${k})`}>
          <circle cx="0" cy="0" r="20" fill="transparent" />
          <rect x="-8" y="-8" width="16" height="16" rx="3" fill="#fff" stroke="#000" strokeOpacity="0.6" strokeWidth="2" />
          <rect x="-4" y="-4" width="8" height="8" rx="1.5" fill={health} />
        </g>
        <g className={styles.handle} transform={`translate(${rx} ${ry}) scale(${k})`}>
          <circle cx="0" cy="0" r="20" fill="transparent" />
          <circle cx="0" cy="0" r="8.5" fill="#fff" stroke="#000" strokeOpacity="0.6" strokeWidth="2" />
          <circle cx="0" cy="0" r="4" fill={health} />
        </g>
      </g>

      {/* The edge of the heightmap, drawn only where you can actually reach it.
          Panned past, the ground simply stops, and an unmarked stop looks like
          a rendering fault rather than the end of the data. */}
      {cover && (
        <rect x="0" y="0" width={MAP_S} height={MAP_S} fill="none" stroke="#fff"
              strokeOpacity="0.35" strokeWidth={1.5 * k} strokeDasharray={`${6 * k} ${4 * k}`} />
      )}

      {/* North arrow and scale bar. Drawn here only when the map sits in a
          column: filling a window, the page draws them in HTML so they do not
          grow with the picture. */}
      {!cover && (
        <>
          <g transform={`translate(${vx0 + pad} ${vy0 + pad}) scale(${k})`} opacity="0.92">
            <line x1="0" y1="52" x2="0" y2="8" stroke="#fff" strokeWidth="2.5" />
            <path d="M-6,18 L0,4 L6,18 Z" fill="#fff" />
            <text x="0" y="70" className={styles.mapLbl} textAnchor="middle">N</text>
          </g>
          <g transform={`translate(${view.cx + halfW - pad} ${view.cy + halfH - pad})`} opacity="0.92">
            <line x1={-barU} y1="0" x2="0" y2="0" stroke="#fff" strokeWidth={3 * k} />
            <line x1={-barU} y1={-4 * k} x2={-barU} y2={4 * k} stroke="#fff" strokeWidth={3 * k} />
            <line x1="0" y1={-4 * k} x2="0" y2={4 * k} stroke="#fff" strokeWidth={3 * k} />
            <g transform={`scale(${k})`}>
              <text x="0" y="-12" className={styles.mapLbl} textAnchor="end">
                {barM >= 1000 ? `${barM / 1000} km` : `${barM} m`}
              </text>
            </g>
          </g>
        </>
      )}
    </svg>
  );
}
// ---------------------------------------------------------------- top view

export function TopView({p, r}) {
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
    <Figure
      items={[
        ['area', inBeam ? OK : WARN, 'sector beam', 'legendBeam'],
        ['solid', inBeam ? OK : WARN, 'rover bearing', 'legendRover'],
      ]}
    >
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
    </Figure>
  );
}

// ------------------------------------------------------- rover pattern view

export function PatternView({p, r}) {
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
    <Figure
      items={[
        ['area', OK, 'rover pattern', 'legendPattern'],
        ['dashed', lossNow < -6 ? BAD : lossNow < -3 ? WARN : OK, 'direction to base', 'legendToBase'],
      ]}
    >
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
        {d1(r.vRover)}° tall · {d1(r.roverGain)} dBi · {p.tilt}° pitch
      </text>
      <text x={10} y={S - 10} className={styles.cap}
            style={lossNow < -3 ? {fill: lossNow < -6 ? BAD : WARN} : undefined}>
        {d1(-lossNow)} dB lost off the peak
      </text>
    </svg>
    </Figure>
  );
}

// ---------------------------------------------------------------- the chart

export function RangeChart({sweep, r}) {
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
  const dUp = line('up');
  const dDown = line('down');

  return (
    <Figure
      note="Mbps each direction would carry if it owned the whole channel"
      items={[
        ['thick', VIDEO, 'rover → base (video)', 'legendVideo'],
        ['dashed', CONTROL, 'base → rover (control)', 'legendControl'],
        ['dashed', WARN, `${VIDEO_FLOOR} Mbps video floor`, 'legendFloor'],
        fitsX !== null && ['dotted', BAD, 'first video dropout', 'legendDropout'],
        ['dotted', 'var(--ifm-color-emphasis-600)', 'where the rover is now', 'legendNow'],
      ]}
    >
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img"
           aria-label="Estimated per-direction capacity against distance, with the range where the whole mission still fits in the channel">
        <rect x="0" y="0" width={W} height={H} rx="8" className={styles.sky} />

        <line x1={padL} y1={yOf(VIDEO_FLOOR)} x2={W - padR} y2={yOf(VIDEO_FLOOR)}
              stroke={WARN} strokeDasharray="4 4" strokeWidth="1.2" />

        {fitsX !== null && (
          <line x1={fitsX} y1={padT} x2={fitsX} y2={H - padB} stroke={BAD}
                strokeWidth="1.5" strokeDasharray="3 3" />
        )}
        <line x1={xOf(r.D)} y1={padT} x2={xOf(r.D)} y2={H - padB} className={styles.cursor} />

        {/* Both curves get a halo in the page background colour so they stay
            readable where they cross each other and the gridlines. */}
        <path d={dDown} fill="none" stroke="var(--ifm-background-color)" strokeWidth="6" strokeOpacity="0.85" />
        <path d={dUp} fill="none" stroke="var(--ifm-background-color)" strokeWidth="6.5" strokeOpacity="0.85" />
        <path d={dDown} fill="none" stroke={CONTROL} strokeWidth="3" strokeDasharray="7 4"
              strokeLinecap="round" />
        <path d={dUp} fill="none" stroke={VIDEO} strokeWidth="3.5" strokeLinecap="round" />

        <circle cx={xOf(r.D)} cy={yOf(r.down.capacity)} r="4.5" fill={CONTROL}
                stroke="var(--ifm-background-color)" strokeWidth="1.5" />
        <circle cx={xOf(r.D)} cy={yOf(r.up.capacity)} r="4.5" fill={VIDEO}
                stroke="var(--ifm-background-color)" strokeWidth="1.5" />

        <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} className={styles.axis} />
        <line x1={padL} y1={padT} x2={padL} y2={H - padB} className={styles.axis} />
        {ticks.map((t) => (
          <text key={t} x={xOf(t)} y={H - 8} className={styles.lblC}>{d1(t / 1000)} km</text>
        ))}
        <text x={4} y={yOf(maxY) + 10} className={styles.cap}>{d0(maxY)}</text>
        <text x={4} y={H - padB} className={styles.cap}>0</text>
      </svg>
    </Figure>
  );
}

// ---------------------------------------------------------------- panels

export function DirPanel({title, sub, dir, need, tag, tone}) {
  const cls = !dir.up ? styles.bad : dir.linkAvail < 0.97 || dir.air > 0.6 ? styles.warn : styles.ok;
  return (
    <div className={`${styles.panel} ${cls}`}>
      <h5>
        {tone && <span className={styles.dirDot} style={{background: tone}} aria-hidden="true" />}
        {title} <small>{sub}</small>
      </h5>
      <table className={styles.kv}>
        <tbody>
          <tr>
            <td>Radio TX <Help id="dirTx" /></td>
            <td>{d1(dir.tx)} dBm <span className={styles.dim}>at MCS{dir.mcs}</span></td>
          </tr>
          <tr>
            <td>EIRP <Help id="dirEirp" /></td>
            <td>
              {d1(dir.eirp)} dBm
              {dir.capped && <span className={styles.capTag}> capped from {d1(dir.eirpRaw)}</span>}
            </td>
          </tr>
          <tr>
            <td>Received <Help id="dirRx" /></td>
            <td><b>{d1(dir.rx)} dBm</b></td>
          </tr>
          <tr>
            <td>Usual rate <Help id="dirRate" /></td>
            <td>
              {dir.up ? `MCS${dir.mcs} · ${d0(dir.phy)} Mbps` : 'none'}
              <span className={styles.dim}>
                {dir.up ? ` · held ${d0(dir.hold * 100)}%` : ` · MCS0 holds ${d0(dir.hold * 100)}%`}
              </span>
            </td>
          </tr>
          <tr>
            <td>Margin there <Help id="dirMargin" /></td>
            <td>{dir.margin >= 0 ? '+' : ''}{d1(dir.margin)} dB <span className={styles.dim}>vs {d0(dir.sens)}</span></td>
          </tr>
          <tr>
            <td>Link margin <Help id="dirLinkMargin" /></td>
            <td><b>{dir.linkMargin >= 0 ? '+' : ''}{d1(dir.linkMargin)} dB</b>{' '}
              <span className={styles.dim}>before it drops</span></td>
          </tr>
          <tr>
            <td>Link uptime <Help id="dirUptime" /></td>
            <td style={dir.linkAvail < 0.97 ? {color: dir.linkAvail < 0.85 ? BAD : WARN} : undefined}>
              <b>{dir.linkAvail > 0.9995 ? '100' : d1(dir.linkAvail * 100)}%</b>{' '}
              <span className={styles.dim}>of the drive</span>
            </td>
          </tr>
          <tr>
            <td>Capacity <Help id="dirCapacity" /></td>
            <td><b>{d1(dir.capacity)} Mbps</b> <span className={styles.dim}>alone on air</span></td>
          </tr>
          <tr>
            <td>Airtime <Help id="dirAirtime" /></td>
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

// Everything the two ends have in common. Shared by both pages so the row set
// and its explanations cannot drift apart.
export function PathPanel({r, sweep}) {
  const range = (m) => rangeText(m, sweep.maxD);
  return (
    <div className={styles.panel}>
      <h5>The path <small>shared by both</small></h5>
      <table className={styles.kv}>
        <tbody>
          <tr>
            <td>Free space loss <Help id="fspl" /></td>
            <td>{d1(r.fsplDb)} dB</td>
          </tr>
          <tr>
            <td>Ground bounce <Help id="groundBounce" /></td>
            <td style={r.ground > 3 ? {color: WARN} : undefined}>
              {r.ground >= 0 ? '+' : ''}{d1(r.ground)} dB
            </td>
          </tr>
          <tr>
            <td>Obstruction <Help id="obstruction" /></td>
            <td>{r.obstruction > 0.05 ? <b>{d1(r.obstruction)} dB</b> : 'none'}</td>
          </tr>
          <tr>
            <td>Total path loss <Help id="pathLoss" /></td>
            <td><b>{d1(r.pathLoss)} dB</b></td>
          </tr>
          <tr>
            <td>Fresnel radius <Help id="f1" /></td>
            <td>{d1(r.f1Mid)} m at midpoint</td>
          </tr>
          <tr>
            <td>Clearance <Help id="clearance" /></td>
            <td>{r.ridgeInPath ? `${d0(r.clearance * 100)}% of F1 at the ridge` : 'nothing in the way'}</td>
          </tr>
          <tr>
            <td>Airtime used <Help id="airtimeTotal" /></td>
            <td style={r.airtime > 0.7 ? {color: r.airtime > 1 ? BAD : WARN} : undefined}>
              <b>{r.airtime > 9.99 ? 'over 1000%' : pct(r.airtime)}</b>
            </td>
          </tr>
          <tr>
            <td>Link first drops at <Help id="linkRange" /></td>
            <td>
              <b>{range(sweep.linkRange)}</b>
              {sweep.linkRecovers && <span className={styles.dim}> then recovers</span>}
            </td>
          </tr>
          <tr>
            <td>Video first drops at <Help id="videoRange" /></td>
            <td>
              <b>{range(sweep.videoRange)}</b>
              {sweep.videoRecovers && <span className={styles.dim}> then recovers</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// What the heightmap says about the ground this link is standing on.
export function SiteCard({p, r, site}) {
  return (
    <div className={styles.mapInfo}>
      <h6>{site.name}<Help id="siteData" /></h6>
      <p className={styles.mapSub}>{site.sub}</p>
      <table className={styles.kv}>
        <tbody>
          <tr>
            <td>Base ground <Help id="groundBase" /></td>
            <td><b>{d0(r.groundBase)} m</b></td>
          </tr>
          <tr>
            <td>Rover ground <Help id="groundRover" /></td>
            <td>{d0(r.groundRover)} m</td>
          </tr>
          <tr>
            <td>Rise to rover <Help id="riseToRover" /></td>
            <td style={Math.abs(r.groundRover - r.groundBase) > 20 ? {color: WARN} : undefined}>
              {r.groundRover - r.groundBase >= 0 ? '+' : ''}{d0(r.groundRover - r.groundBase)} m
            </td>
          </tr>
          <tr>
            <td>Worst clearance <Help id="worstClearance" /></td>
            <td style={r.clearance < 0.6 ? {color: r.clearance < 0 ? BAD : WARN} : undefined}>
              <b>{d0(r.clearance * 100)}%</b> of F1
            </td>
          </tr>
          <tr>
            <td>Pinched at <Help id="pinchedAt" /></td>
            <td>{r.ridgeInPath ? `${d0(r.pinchAt)} m out` : 'clear path'}</td>
          </tr>
          <tr>
            <td>Ground roughness <Help id="roughness" /></td>
            <td>{d1(r.refSigma)} m RMS</td>
          </tr>
          <tr>
            <td>Off boresight <Help id="offBoresight" /></td>
            <td>{d0(r.bearingOff)}°</td>
          </tr>
          <tr>
            <td>Heading <Help id="headingRow" /></td>
            <td>{d0(p.heading)}° · {d0(r.D)} m</td>
          </tr>
        </tbody>
      </table>
      <p className={styles.mapAttr}>
        {site.lat.toFixed(4)}, {site.lon.toFixed(4)} · {site.min}–{site.max} m · USGS
      </p>
    </div>
  );
}

export function InfoPanel({gear}) {
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
        heightmap: a 6 km square around either the Mars Desert Research Station or the Rolla test
        site, baked from USGS 3DEP via the AWS Terrain Tiles open dataset and committed to the repo
        so the page never depends on a live elevation API. Every value was spot-checked against the
        USGS <code>ned10m</code> service before it was written.
      </p>
      <p>
        It arrives in two resolutions, because rendering on a server and cutting an honest path
        profile want different things. A 30 m grid is inlined in the page, so the map draws
        immediately and works with no network at all; a 11.7 m one — 3DEP's own sampling, and the
        finest that is real rather than interpolated — is a plain file the browser fetches once and
        caches, and the model re-runs against it the moment it lands. The path profile follows
        whichever grid is loaded rather than a fixed step, so the finer data actually reaches the
        diffraction and Fresnel numbers instead of being resampled away. The satellite view does
        the same thing: a baked 2.9 m image underneath as the floor, live USGS National Map tiles
        laid over it at whatever level matches your zoom, down to 1.9 m — which is where USGS stops
        and everything past it would be invented detail.
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
        The sliders describe the antenna <b>at the band it was measured on</b> — 5.8 GHz unless the
        part in the slot says otherwise. An aperture keeps its physical size, not its beamwidth, so
        switching to 2.4 GHz stretches every beamwidth by the wavelength ratio of 2.38. A panel has
        two dimensions of aperture and gives up <code>20log₁₀(2.38) ≈ 7.5 dB</code>; a vertical
        omni has one and gives up <code>10log₁₀(2.38) ≈ 3.8 dB</code>. That is not a fudge, it is
        why the rover omni in the bill of materials is spec'd 6.7 dBi at 5 GHz and 3.6 at 2.4, and
        why an 18 dBi panel with a 20°×20° beam becomes a <b>10.5 dBi</b> panel with a 48°×48° beam
        when you change bands. The upshot: 2.4 GHz buys you 7.5 dB of free-space loss and then
        hands all of it straight back in antenna gain, and the ground reflection does not care
        about frequency at all.
      </p>
      <p>
        That loss is taken off the gain the part <i>claims</i>, not off the gain its beamwidths
        allow — which matters more than it sounds. The gap between the two is the antenna's own
        efficiency, and efficiency is a property of the metal: a panel sitting 2 dB under its
        directivity at 5.8 GHz is still 2 dB under it at 2.4. Charging the band change against the
        ceiling instead would quietly hand that gap back as free gain, and hand back the most to
        exactly the honest, conservatively specified parts this page tells you to prefer.
      </p>
      <p>
        <b>Two chains is not two streams.</b> A 2×2 radio needs two antenna paths that see
        genuinely different channels, and on a clean line of sight that means two polarizations —
        there is no multipath to tell co-polar elements apart. One connector is one stream. Two
        connectors of the same polarization, which is what a pair of vertical omnis on a rover mast
        is, is also one stream: the channel matrix is rank one and the second stream has nowhere to
        live. So the antennas cap the link independently of the radios, and the studio says which
        of the two is binding. It is the commonest way to pay for a 2×2 link and fly a 1×1 one.
      </p>
      <p>
        A <b>yagi</b> is the exception worth knowing. It is not an aperture but an end-fire array,
        and its gain follows boom length in wavelengths rather than area in wavelengths squared —
        so off its own band it gives up only <code>10log₁₀</code> of the ratio where a panel gives
        up 20. A beam that still has to satisfy <code>D ≈ 41253/(H × V)</code> can therefore only
        broaden by the <i>square root</i> of the ratio, and the lab stretches it by exactly that.
        The same identity is what keeps an omni honest in the other direction: it stays round in
        azimuth on every band it works on, so all of its 10log₁₀ shows up as a taller toroid.
      </p>
      <p>
        <b>900 MHz</b> is the band that changes the argument rather than the arithmetic. It has
        16 dB less free-space loss than 5.8 GHz and a wavelength that diffracts over a ridge
        instead of stopping at it, which is why the obstruction row collapses when you switch to
        it. What you pay is spectrum: 902–928 MHz is 26 MHz wide in total, so 40 MHz is not a
        channel that exists and the rate ceiling arrives long before the range does. It is also the
        one band with no point-to-point relief — §15.247(b)(3) names 2.4 and 5.8 and stops there —
        so 900 MHz is pinned at 36 dBm EIRP however you deploy it, and a bigger yagi buys pattern
        and reach but never power.
      </p>

      {gear && (
        <>
          <h5>What a radio configuration actually changes</h5>
          <p>
            A radio here is five things and nothing else: a <b>rate ladder</b> (the PHY generation,
            which fixes both the per-stream Mbps and how many rungs exist), a <b>sensitivity
            curve</b>, a per-band <b>conducted power ceiling</b>, the <b>channel widths</b> it
            will tune, and the <b>Ethernet port</b> behind it. That last one is not RF and is
            easily the most decisive spec on an M-series Rocket: 10/100 is a hard 94 Mbps whatever
            the air does, the link is held to the slower of the two ends, and no antenna on the
            market moves it. The curve is generated from the two numbers a datasheet actually prints —
            sensitivity at the bottom rung and at the top — by rescaling the published shape of a
            real receiver of that generation between them, so you never have to invent the ten
            values in the middle.
          </p>
          <p>
            Both ends are specified separately, because a link is not symmetric. The transmit side
            supplies power and its own backoff; the receive side supplies sensitivity, so making the
            base deaf hurts <i>rover to base</i> and leaves the other direction untouched. The rung
            list is the intersection of the two ladders and the stream count is the weaker end's, so
            an 802.11n radio at one end pins an ax radio at the other to MCS7. If the two share no
            band at all there is no link, and the page says so rather than quietly solving one.
          </p>
          <p>
            An antenna is a gain, the beamwidths that gain has to be consistent with, and how many
            RF ports it has at which polarizations. Dropping one into a slot writes the sliders;
            moving a slider afterwards is drift, not an error, and the slot says <i>edited</i>
            until you either save it as a new part or pick the old one again. Ports and
            polarization are not sliders — they are what the part <i>is</i> — so they follow the
            part and are what decide the stream count. The rover slot models a vertical omni whose
            toroid follows from its gain, so a sector dropped there contributes gain only.
          </p>
        </>
      )}

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
        <li>MIMO is counted as streams of rate, not as spatial diversity against fades. On a
          real desert path the diversity is often worth more than the rate.</li>
        <li>Stream count from polarization is all-or-nothing: cross-polarised gets the full count,
          co-polarised gets one. Reality is a spectrum, and a co-polar pair on a badly obstructed
          path can find some rank in the scatter. On the clear paths this page is arguing about,
          one is the right answer.</li>
      </ul>
      <p className={styles.infoFoot}>
        The physics is real and the datasheet numbers are real. Use it to build intuition for which
        knob matters, then go drive-test with RSSI logging before you trust any of it at competition.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- overlay

// A modal sheet for the things that do not fit beside a live model: the
// explanation of what it computes, and the gear library. Escape and a click on
// the backdrop both close it, because a full-page tool that traps you in a
// dialog is worse than one with no dialog at all.
export function Overlay({title, sub, onClose, wide, children}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div className={styles.overlayBack} onClick={onClose} />
      <div className={`${styles.overlayCard} ${wide ? styles.overlayWide : ''}`}>
        <div className={styles.overlayHead}>
          <div>
            <h4>{title}</h4>
            {sub && <p>{sub}</p>}
          </div>
          <button type="button" className={styles.overlayClose} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className={styles.overlayBody}>{children}</div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- readouts

// The one-line answer, in the order the numbers actually fail: the link being
// there at all, then the mission fitting in the airtime, then the margin that
// decides whether either stays true tomorrow.
export function verdictOf(r) {
  const linkUp = r.up.up && r.down.up;
  const minAvail = Math.min(r.up.linkAvail, r.down.linkAvail);
  const minMargin = Math.min(r.up.linkMargin, r.down.linkMargin);
  if (!r.bandOk) {
    return {cls: 'bad', minAvail, minMargin,
      txt: 'These two radios share no band. Pick a band both ends can tune, or a different radio.'};
  }
  if (!linkUp) {
    return {cls: 'bad', minAvail, minMargin,
      txt: `Link is down more often than not: even the bottom rate only holds ${d1(minAvail * 100)}% of the drive.`};
  }
  if (r.airtime > 1) {
    return {cls: 'bad', minAvail, minMargin,
      txt: `The mission does not fit. Video plus control needs ${pct(r.airtime)} of the airtime and you only have 100%.`};
  }
  if (minAvail < 0.97) {
    return {cls: 'warn', minAvail, minMargin,
      txt: `The link itself drops out ${d1((1 - minAvail) * 100)}% of the drive, on only ${d1(minMargin)} dB of margin. Buy margin before anything else.`};
  }
  if (r.airtime > 0.7) {
    return {cls: 'warn', minAvail, minMargin,
      txt: `It fits, but only just: ${pct(r.airtime)} of the airtime is already spoken for.`};
  }
  return {cls: 'ok', minAvail, minMargin,
    txt: `Video and control both fit in ${pct(r.airtime)} of the airtime, on ${d0(minMargin)} dB of link margin.`};
}

// Which direction to spend money on, and — the part that matters — whether
// money can even help it. Gain on a capped transmitter buys you nothing.
export function adviceOf(r) {
  const upIsWorse = r.up.linkMargin <= r.down.linkMargin;
  if (upIsWorse) {
    return 'rover to base — base antenna gain buys margin here, receive gain being uncapped.';
  }
  return r.down.capped
    ? 'base to rover — and gain will not fix it, that transmitter is at the Part 15 ceiling. Mast, cable and channel width are the levers.'
    : 'base to rover — not at the regulatory ceiling yet, so TX power and cable loss still buy something.';
}

// The sweep stops at the edge of the chart. Saying "5.0 km" when the link never
// broke would read like a computed answer instead of running out of road.
export const rangeText = (m, maxD) =>
  m > maxD ? `> ${d1(maxD / 1000)} km` : `${d1(m / 1000)} km`;
