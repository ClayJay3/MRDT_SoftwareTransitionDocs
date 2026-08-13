import React, {useEffect, useMemo, useRef, useState} from 'react';
import shared from './signalViews.module.css';
import styles from './SignalStudio.module.css';
import {SITES, SPAN_M, siteLabel} from './terrainModel';
import {
  BANDS,
  CONTROL_FLOOR,
  COVER_METRICS,
  DEFAULTS,
  PRESETS,
  RULE_MAX_WIDTH,
  clamp,
  coverageField,
  coverageReach,
  coverageSignature,
  dbToLin,
  linkLimits,
  log10,
  REF_MHZ,
  sensitivity,
  solve,
  solveBands,
  sweepRange,
  VIDEO_FLOOR,
} from './signalModel';
import {
  BandsPanel,
  CONTROL,
  ComparePanel,
  CostPanel,
  CoverageLegend,
  DirPanel,
  clampMapView,
  Help,
  InfoPanel,
  MapView,
  OVER_PAN,
  Overlay,
  panRoom,
  PathPanel,
  PatternView,
  Pills,
  RangeChart,
  SideView,
  SiteCard,
  Slider,
  SpecCheck,
  TopView,
  TornadoPanel,
  VIDEO,
  adviceOf,
  d0,
  d1,
  useDebounced,
  useFineTerrain,
  verdictOf,
} from './signalViews';
import GearLibrary from './GearLibrary';
import {
  BUILTIN_ANTENNAS,
  BUILTIN_RADIOS,
  antennaFromBase,
  antennaFromRover,
  applyBaseAntenna,
  applyRoverAntenna,
  bandOfMHz,
  baseMatches,
  antennaPayload,
  buildCost,
  legacyGear,
  markMigrated,
  newId,
  normalizeAntenna,
  normalizeRadioSpec,
  profileCsv,
  radioPayload,
  radioSummary,
  reconcileLink,
  roverMatches,
} from './signalGear';
import {benchFromLocation, benchUrl, syncLocation} from './signalLink';
import {benchSource, normalizeBench} from '../../data/benches';
import {EMPTY_LIBRARY, deleteItem, fetchLibrary, saveItem} from './gearApi';

// The full-page version of the link lab. Same physics and the same views as the
// doc-page embed, but with the whole viewport to spend: controls down the left,
// the ground in the middle, the link budget down the right.
//
// What it adds is the gear library. On the doc page an antenna is four sliders
// you nudge and lose; here it is a part you define once, name, save and put
// back in the slot next week, and a radio stops being a fixed assumption of
// the model and becomes something you can type in off a datasheet.

const STOCK_IDS = new Set([...BUILTIN_ANTENNAS, ...BUILTIN_RADIOS].map((x) => x.id));

// Where to park the tripod on each site. A position means nothing across two
// different heightmaps, so switching terrain moves you to that site's own
// starting point rather than leaving you in whatever wash the coordinates
// happen to land in. Both are genuinely clear 1 km paths: the page should open
// on a link that works, so the first thing you break is something you chose.
const SITE_HOME = {
  mdrs: {baseE: -300, baseN: -300, aim: 45, heading: 45},
  rolla: {baseE: -600, baseN: -300, aim: 345, heading: 345},
  // On the plain north of the mesa, aimed due west across the flat, which is a
  // clear 1 km path. Swing the aim round to the south-east and the rising
  // ground takes 40 to 68 dB out of it, which is the exercise this site is
  // here for: one tripod, two headings, opposite answers.
  tucumcari: {baseE: 0, baseN: -1400, aim: 270, heading: 270},
};

// Real ground only. The synthetic flat-plus-one-ridge world is a bench for
// isolating a single mechanism, which is what the doc-page embed is for; the
// studio is the siting tool and every one of its instruments wants a heightmap.
// Leaving the option here meant a mode where the map, the coverage sweep and
// half the readouts had nothing to draw.
const TERRAINS = SITES.map((s) => [s.id, siteLabel(s.id)]);

// The studio opens on real ground, because a full-page layout has room for the
// map and the map is where the siting argument actually gets made.
const STUDIO_DEFAULTS = {
  ...DEFAULTS,
  site: 'mdrs',
  ...SITE_HOME.mdrs,
  baseRadio: BUILTIN_RADIOS[0],
  roverRadio: BUILTIN_RADIOS[0],
};

const DEFAULT_SLOTS = {
  baseAnt: 'signalplus-panel',
  roverAnt: 'mikrotik-hgo',
  baseRadio: 'netmetal-ax',
  roverRadio: 'netmetal-ax',
};

// The shared library: what the service has, who it thinks you are, and whether
// it answered at all. `cached` means this is the last good copy from this
// browser rather than a live one.
// The studio has no synthetic world any more, so anything arriving from a link,
// a saved bench or a scenario that asks for one lands on real ground instead.
// One gate rather than a check at each entry point.
const onGround = (site) => (SITES.some((x) => x.id === site) ? site : STUDIO_DEFAULTS.site);

const EMPTY_LIB = {
  loading: true, ok: false, reason: '', cached: false,
  library: EMPTY_LIBRARY, you: null, moderator: false,
};

// ------------------------------------------------------------------ boxes

// A control group as a collapsed card floating over the map. <details> rather
// than React state on purpose: it is keyboard-operable, it survives re-renders
// for free, and the browser already knows how to animate it.
//
// The summary carries the setting it holds, so the stack still reads as a
// status line when every box is shut, which is how it starts, because the map
// is the point and the controls are what you reach for.
function Box({title, badge, help, children}) {
  return (
    <details className={styles.box}>
      <summary className={styles.boxHead}>
        <span className={styles.boxMark} aria-hidden="true" />
        <span className={styles.boxTitle}>{title}{help && <Help id={help} />}</span>
        {badge && <span className={styles.boxBadge}>{badge}</span>}
      </summary>
      <div className={styles.boxBody}>{children}</div>
    </details>
  );
}

// --------------------------------------------------------- the analysis card
//
// Four readouts that earn their place and do not each earn a third of the rail.
// One card the width of the rail, one tab strip.
//
// It trades places with the drawings rather than competing with them for a
// hundred pixels. Squeezed in beside them there was room for three rows of a
// nine-row table, which is not a smaller version of the feature. It is the
// feature not working. Both stacks are things you read rather than things you
// watch, so the honest answer is that you want one or the other: closed, the
// rail is exactly the layout it always was; open, the analysis has the whole
// rail and every tab fits without scrolling.
//
// Closed it still carries the headline of whichever tab is selected, because a
// card that says nothing until you open it does not get opened.
function AnalysisCard({tabs, tab, setTab, open, setOpen}) {
  const active = tabs.find((t) => t.id === tab) || tabs[0];
  return (
    <details
      className={`${styles.box} ${styles.analysis}`}
      open={open}
      // Controlled, because the drawings underneath need to know: an
      // uncontrolled <details> keeps its state in the DOM where React cannot
      // see it, and the two would disagree the first time it was toggled.
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className={styles.boxHead}>
        <span className={styles.boxMark} aria-hidden="true" />
        <span className={styles.boxTitle}>Analysis</span>
        <span className={styles.boxBadge}>{active.badge}</span>
      </summary>
      <div className={styles.boxBody}>
        <div className={styles.tabs} role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === active.id}
              className={`${styles.tab} ${t.id === active.id ? styles.tabOn : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className={styles.analysisBody} role="tabpanel">{active.body}</div>
      </div>
    </details>
  );
}

// ------------------------------------------------------------------ slots

function Slot({label, help, value, options, drift, driftLabel, summary, onPick, onSaveAs}) {
  return (
    <div className={styles.slot}>
      <div className={styles.slotTop}>
        <span className={styles.slotLbl}>{label}{help && <Help id={help} />}</span>
        {drift && (
          <button type="button" className={styles.slotSave} onClick={onSaveAs}>
            save as new…
          </button>
        )}
      </div>
      <select
        className={styles.select}
        value={drift ? '__drift' : value}
        onChange={(e) => onPick(e.target.value)}
      >
        {drift && <option value="__drift">{driftLabel}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <span className={styles.slotSub}>{summary}</span>
    </div>
  );
}

// ------------------------------------------------------------- the studio

export default function SignalStudio() {
  const [p, setP] = useState(STUDIO_DEFAULTS);
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  const [lib0, setLib0] = useState(EMPTY_LIB);
  const [view, setView] = useState({cx: 500, cy: 500, z: 1, layer: 'sat'});
  const [showInfo, setShowInfo] = useState(false);
  const [lib, setLib] = useState(null); // {tab, draft} while the library is open
  // The map fills the window, so how far it can be panned depends on the shape
  // of the window. It reports that back rather than the page guessing.
  const [mapAr, setMapAr] = useState(1);
  // Coverage is off until asked for: it is three thousand solves, and most
  // visits are about one link rather than about a whole drive.
  const [cover, setCover] = useState({on: false, metric: 'uptime'});
  const [pinned, setPinned] = useState(null); // the A side of a comparison
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('fix');
  // Shut by default: the drawings are what the rail has always shown, and the
  // analysis summary bar is enough to invite the click.
  const [analysisOpen, setAnalysisOpen] = useState(false);

  // The library is fetched once, on mount. It is small, everything on the page
  // needs it, and a studio that waited on the network before drawing a map
  // would be a worse trade than a library that fills in a moment later.
  const loadLibrary = async () => {
    const res = await fetchLibrary();
    setLib0({loading: false, ...res, reason: res.reason || ''});
    return res;
  };
  useEffect(() => {
    loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Anyone who saved gear before the service existed still has it in this
  // browser. Offer to push it up once, then stop asking.
  const [legacy, setLegacy] = useState(null);
  useEffect(() => setLegacy(legacyGear()), []);

  const migrateLegacy = async () => {
    if (!legacy) return;
    for (const a of legacy.antennas) await saveItem('antennas', antennaPayload(a));
    for (const r of legacy.radios) await saveItem('radios', radioPayload(r));
    for (const b of legacy.benches) await saveItem('benches', b);
    markMigrated();
    setLegacy(null);
    await loadLibrary();
  };

  // A shared link wins over the defaults, but only on the first paint, after
  // that the address bar follows the bench rather than the other way round, or
  // every slider would fight the URL it just wrote.
  //
  // The flag is load-bearing, not defensive: both effects run on the same
  // commit, and the writer would otherwise stamp the *pre-load* bench over the
  // very token it is still being read from. It self-corrected a beat later, but
  // anyone who copied the URL in that beat got the defaults.
  const loaded = useRef(false);
  useEffect(() => {
    const shared = benchFromLocation();
    if (shared) {
      setP((s) => reconcileLink({...s, ...shared.p, site: onGround(shared.p.site ?? s.site)}));
      if (shared.slots) setSlots((s) => ({...s, ...shared.slots}));
    }
    loaded.current = true;
  }, []);

  // Saving goes to the service and the library is re-read, so every client
  // converges on the same list rather than on its own idea of it.
  const commitItem = async (kind, payload) => {
    const res = await saveItem(kind, payload);
    if (!res.ok) return res;
    const fresh = await loadLibrary();

    // Editing a part that is sitting in a slot has to move the link you are
    // looking at, not just the library entry. Antennas are only refreshed when
    // the sliders still match the saved part. Otherwise a save would throw
    // away edits you had not saved yet.
    const radioNow = (id) =>
      [...BUILTIN_RADIOS.map(normalizeRadioSpec), ...fresh.library.radios].find((x) => x.id === id);
    const antNow = (id) =>
      [...BUILTIN_ANTENNAS.map(normalizeAntenna), ...fresh.library.antennas].find((x) => x.id === id);
    setP((cur) => {
      let out = cur;
      const br = radioNow(slots.baseRadio);
      if (br) out = {...out, baseRadio: br};
      const rr = radioNow(slots.roverRadio);
      if (rr) out = {...out, roverRadio: rr};
      const ba = antNow(slots.baseAnt);
      if (ba && !baseDrift) out = {...out, ...applyBaseAntenna(ba)};
      const ra = antNow(slots.roverAnt);
      if (ra && !roverDrift) out = {...out, ...applyRoverAntenna(ra)};
      return reconcileLink(out);
    });
    return res;
  };

  const removeItem = async (kind, id) => {
    const res = await deleteItem(kind, id);
    if (res.ok) await loadLibrary();
    return res;
  };

  const antennas = useMemo(
    () => [
      ...BUILTIN_ANTENNAS.map(normalizeAntenna).map((a) => ({...a, origin: 'builtin'})),
      ...lib0.library.antennas,
    ],
    [lib0.library.antennas],
  );
  const radios = useMemo(
    () => [
      ...BUILTIN_RADIOS.map(normalizeRadioSpec).map((r) => ({...r, origin: 'builtin'})),
      ...lib0.library.radios,
    ],
    [lib0.library.radios],
  );
  const antById = (id) => antennas.find((a) => a.id === id);
  const radioById = (id) => radios.find((rr) => rr.id === id);

  const set = (k) => (v) => setP((s) => ({...s, [k]: v}));
  const patch = (o) => setP((s) => ({...s, ...o}));

  // Scenarios reset the link, not the gear you selected or where you have put
  // yourself on the map: the point of a scenario is to show what one mistake
  // costs on the bench you are actually looking at.
  const preset = (patchIn) =>
    setP((s) =>
      reconcileLink({
        ...STUDIO_DEFAULTS,
        site: s.site,
        baseE: s.baseE,
        baseN: s.baseN,
        aim: s.aim,
        heading: s.heading,
        baseRadio: s.baseRadio,
        roverRadio: s.roverRadio,
        ...patchIn,
        // A scenario that only makes sense on the synthetic ridge keeps the
        // ground you are standing on instead of teleporting you off the map.
        site: onGround(patchIn.site ?? s.site),
      }),
    );

  const setSite = (v) => {
    setP((s) => ({...s, site: onGround(v), ...(SITE_HOME[v] || {})}));
    setView((w) => ({...w, cx: 500, cy: 500, z: 1}));
  };
  const zoomBy = (f) =>
    setView((w) => ({...w, ...clampMapView(w.cx, w.cy, clamp(w.z * f, 1, 8), mapAr, OVER_PAN)}));

  // --- gear in and out of the slots

  const useAntenna = (id, which) => {
    const a = antById(id);
    if (!a) return;
    setSlots((s) => ({...s, [which === 'base' ? 'baseAnt' : 'roverAnt']: id}));
    patch(which === 'base' ? applyBaseAntenna(a) : applyRoverAntenna(a));
  };

  const useRadio = (id, which) => {
    const spec = radioById(id);
    if (!spec) return;
    setSlots((s) => ({...s, [which === 'base' ? 'baseRadio' : 'roverRadio']: id}));
    setP((s) => reconcileLink({...s, [which === 'base' ? 'baseRadio' : 'roverRadio']: spec}));
  };

  // A published bench names its gear by id and carries only the settings that
  // differ from the defaults, so loading one is: start clean, put the gear in
  // the slots, then overlay what the entry actually says.
  const applyBench = (b) => {
    const slotsNext = {...DEFAULT_SLOTS, ...b.slots};
    const baseR = radioById(slotsNext.baseRadio);
    const roverR = radioById(slotsNext.roverRadio);
    const baseA = antById(slotsNext.baseAnt);
    const roverA = antById(slotsNext.roverAnt);
    setSlots(slotsNext);
    setP(
      reconcileLink({
        ...STUDIO_DEFAULTS,
        ...(SITE_HOME[onGround(b.params.site)] || {}),
        ...(baseR ? {baseRadio: baseR} : {}),
        ...(roverR ? {roverRadio: roverR} : {}),
        ...(baseA ? applyBaseAntenna(baseA) : {}),
        ...(roverA ? applyRoverAntenna(roverA) : {}),
        ...b.params,
        site: onGround(b.params.site),
      }),
    );
    setView((w) => ({...w, cx: 500, cy: 500, z: 1}));
    setLib(null);
  };

  // The entry a contributor pastes into the catalogue. Only the settings that
  // differ from the defaults travel, for the same reason the share link only
  // carries differences: a diff of six values says what the bench is about,
  // and a dump of forty does not.
  const paramsDiff = () => {
    const params = {};
    for (const [k, v] of Object.entries(p)) {
      if (k === 'baseRadio' || k === 'roverRadio') continue;
      if (v !== STUDIO_DEFAULTS[k]) params[k] = v;
    }
    return params;
  };

  const preparePublish = () => {
    const params = paramsDiff();
    const ant = antById(slots.baseAnt);
    return benchSource(
      normalizeBench({
        id: `${p.site}-${p.band.replace('.', '')}-bench`,
        name: ant ? `${ant.name}, ${p.band} GHz` : `${p.band} GHz bench`,
        by: 'your name here',
        added: new Date().toISOString().slice(0, 10),
        tags: [p.band, p.site].filter(Boolean),
        note: 'Say what this bench is for and what to look at when it loads.',
        slots,
        params,
      }),
    );
  };

  const publishCurrent = async (name, note) =>
    commitItem('benches', {
      name,
      note,
      tags: [p.band, p.site].filter(Boolean),
      slots,
      params: paramsDiff(),
    });

  // --- the model

  // The bundled 30 m heightmap is what the first frame is drawn on; the 11.7 m
  // one arrives a moment later and the model has to be re-run against it.
  const {rev: fineRev, fine} = useFineTerrain(p.site);

  const r = useMemo(() => solve(p, p.distance), [p, fineRev]);
  const sweep = useMemo(() => sweepRange(p), [p, fineRev]);
  const limits = useMemo(() => linkLimits(p.baseRadio, p.roverRadio), [p.baseRadio, p.roverRadio]);
  const multi = useMemo(() => solveBands(p, p.distance), [p, fineRev]);
  const sens = useMemo(() => sensitivity(p, p.distance), [p, fineRev]);

  // The coverage sweep is the one expensive thing here, about 3000 solves, so
  // 35 ms on the bundled grid and triple that on the fine one. Two guards keep
  // it off the critical path: the signature deliberately excludes the rover's
  // position, so driving the rover around never re-runs it, and what is left is
  // debounced so dragging the tripod recomputes once at the end rather than
  // sixty times on the way.
  const coverSig = coverageSignature(p);
  const settledSig = useDebounced(`${coverSig}|${fineRev}|${cover.on}`, 140);
  const coverage = useMemo(() => {
    if (!cover.on) return null;
    return coverageField(p, coverageReach(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settledSig]);

  // What this build costs, and what the pinned one did.
  const cost = useMemo(
    () => buildCost({
      baseAnt: antById(slots.baseAnt),
      roverAnt: antById(slots.roverAnt),
      baseRadio: radioById(slots.baseRadio),
      roverRadio: radioById(slots.roverRadio),
    }),
    [slots, antennas, radios],
  );

  // Keep the address bar in step with the bench so the URL is always shareable
  // without anyone pressing anything. replaceState, so the back button still
  // belongs to the reader rather than to the slider they just dragged.
  const shareSig = useDebounced(`${JSON.stringify(p)}|${JSON.stringify(slots)}`, 400);
  useEffect(() => {
    if (!loaded.current) return;
    syncLocation(p, slots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareSig]);

  // --- comparing, sharing, exporting

  // A pinned build is a frozen snapshot of its own numbers, not a pointer at
  // live state: the whole value of A/B is that A holds still while you take B
  // apart. Its coverage figure is only carried if coverage was on when you
  // pinned, so the comparison never invents one.
  const snapshot = (name) => ({
    name,
    r,
    sweep,
    cost: cost.total,
    lateral: r.lateral,
    workableKm2: coverage ? coverage.workableKm2 : null,
    // Carried so the pin can be put back on the bench, which is what makes
    // swapping a real move rather than a relabelling.
    params: p,
    slots,
  });

  const nameOf = () => {
    const ant = antById(slots.baseAnt);
    return ant ? `${ant.name}, ${p.band} GHz` : `${p.band} GHz bench`;
  };

  // Pinning is only worth doing because of what it shows, so show it.
  const pinCurrent = () => {
    setPinned(snapshot(nameOf()));
    setTab('ab');
    // Pinning is only worth doing because of what it shows, so open the card
    // and put the comparison in front of them.
    setAnalysisOpen(true);
  };

  // Put A on the bench and pin what was there. Flipping between two builds is
  // how you actually decide between them, and it has to be one click.
  const swapPinned = () => {
    if (!pinned) return;
    const wasLive = snapshot(nameOf());
    setPinned(wasLive);
    setP(reconcileLink({...STUDIO_DEFAULTS, ...pinned.params}));
    setSlots({...DEFAULT_SLOTS, ...(pinned.slots || {})});
  };

  const live = snapshot('live');
  // A pinned side that measured coverage against a live side that has not is a
  // blank row, not a false one. CMP_ROWS drops any row either side is missing.
  const cmpA = pinned && {...pinned, workableKm2: coverage ? pinned.workableKm2 : null};

  const share = async () => {
    const url = benchUrl(p, slots);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be refused outright; putting the reader in the
      // address bar is a worse experience than a prompt but better than a
      // button that silently does nothing.
      window.prompt('Copy this link', url);
    }
  };

  // Straight to a file. The page tells you to cross-check this against SPLAT! or
  // Radio Mobile before competition, which is only actionable if the profile can
  // leave the browser.
  const exportProfile = () => {
    const csv = profileCsv(r, p);
    if (!csv) return;
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv'}));
    const a = document.createElement('a');
    a.href = url;
    a.download = `profile-${p.site}-${d0(p.heading)}deg-${d0(r.D)}m.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const siteInfo = SITES.find((s) => s.id === p.site) || SITES[0];
  const verdict = verdictOf(r);
  const advice = adviceOf(r);

  const baseAnt = antById(slots.baseAnt);
  const roverAnt = antById(slots.roverAnt);
  const baseDrift = baseAnt ? !baseMatches(p, baseAnt) : true;
  const roverDrift = roverAnt ? !roverMatches(p, roverAnt) : true;

  // Antennas are described at the band they were measured on, which is only
  // 5.8 GHz until you put a 900 MHz part in a slot. Every label that used to say
  // "at 5.8" reads it off the part instead, and the derived line appears
  // whenever the link is running somewhere other than there.
  const baseAt = BANDS[bandOfMHz(p.baseRefMHz)].label;
  const roverAt = BANDS[bandOfMHz(p.roverRefMHz)].label;
  const baseOffBand = (p.baseRefMHz || REF_MHZ) !== BANDS[p.band].fMHz;
  const roverOffBand = (p.roverRefMHz || REF_MHZ) !== BANDS[p.band].fMHz;

  const txCeil = limits.txMax(p.band);
  const bandOpts = limits.bands.length
    ? limits.bands.map((id) => [id, BANDS[id].label])
    : [[p.band, `${BANDS[p.band].label}. Unsupported`]];
  const widthOpts = limits.widthsFor(p.band);

  const openLibrary = (init) => setLib(init || {tab: 'antennas'});

  // The four analysis readouts, each with the one number worth showing while the
  // card is shut. A/B only exists once something has been pinned, so the strip
  // grows rather than offering a tab with nothing behind it.
  const best = sens.rows[0];
  const analysisTabs = [
    {
      id: 'fix',
      label: 'What to fix first',
      badge: best && best.gain > 0.05
        ? `best move: ${best.label}, ${best.gain > 0 ? '+' : ''}${d1(best.gain)} dB`
        : 'nothing on this bench is worth more than a dB',
      body: <TornadoPanel sens={sens} />,
    },
    {
      id: 'bands',
      label: 'Both bands',
      badge: multi.split
        ? `video on ${multi.video.label}, control on ${multi.control.label}`
        : multi.bands.length
          ? `${multi.bands.length} band${multi.bands.length > 1 ? 's' : ''} · ${d1(multi.availLo * 100)}% up`
          : 'no band in common',
      body: <BandsPanel multi={multi} />,
    },
    {
      id: 'cost',
      label: 'What it costs',
      badge: `$${cost.total} per side${
        r.linkMargin > 0 && cost.total > 0 ? ` · $${d0(cost.total / r.linkMargin)} per dB` : ''
      }`,
      body: <CostPanel cost={cost} r={r} />,
    },
    ...(cmpA
      ? [{
          id: 'ab',
          label: 'A / B',
          badge: `A ${cmpA.name}`,
          body: <ComparePanel a={cmpA} b={live} onClear={() => setPinned(null)} onSwap={swapPinned} />,
        }]
      : []),
  ];

  // The map spans the viewport exactly, so a ground distance is a share of it:
  // no pixel measurement needed, at any zoom. A tenth of the window is the
  // longest bar the row it sits in can spare, and the bar is drawn at whatever
  // share it works out to, so the step has to be chosen to fit rather than the
  // drawn line being clamped afterwards.
  const scaleBar = useMemo(() => {
    const acrossM = SPAN_M / view.z;
    const m = [2000, 1000, 500, 200, 100, 50, 20].find((v) => v <= acrossM * 0.1) || 20;
    return {vw: (m / acrossM) * 100, label: m >= 1000 ? `${m / 1000} km` : `${m} m`};
  }, [view.z]);

  // The hint names the directions that actually have somewhere to go, rather
  // than promising a drag the clamp will refuse.
  const panText = useMemo(() => {
    const room = panRoom(view.z, mapAr, OVER_PAN);
    const zoom = view.z < 8 ? ', scroll to zoom' : '';
    if (room.x > 1 && room.y > 1) return `drag to pan${zoom}`;
    if (room.y > 1) return `drag up and down${zoom}`;
    if (room.x > 1) return `drag left and right${zoom}`;
    return `whole site shown${zoom}`;
  }, [view.z, mapAr]);

  return (
    <div className={styles.studio}>
      {/* -------------------------------------------------- the ground, full bleed */}
      <div className={styles.mapLayer}>
          <MapView
            cover
            chrome={0.7}
            p={p} r={r} view={view} setView={setView}
            onChange={patch} onAspect={setMapAr}
            coverage={coverage} coverMetric={cover.metric}
          />
      </div>

      {/* ------------------------------------------- everything else floats on top */}
      <div className={`${styles.shell} ${shared.glass} ${shared.dense}`}>
        {/* top left: the bench, collapsed until you need it */}
        <div className={styles.tl}>
          <Box title="Terrain" badge={siteInfo.name} help="site">
            <Pills label="Ground" value={p.site} options={TERRAINS} onChange={setSite} />
            <SiteCard p={p} r={r} site={siteInfo} />
            {(
              <button type="button" className={styles.linkBtn} onClick={exportProfile}>
                Export this path profile (CSV)
              </button>
            )}
          </Box>

          <Box title="The bench" badge={baseAnt ? baseAnt.name : 'custom'} help="gearBaseAnt">
            <Slot
              label="Base radio" help="gearBaseRadio" value={slots.baseRadio} options={radios}
              summary={radioSummary(limits.base)} onPick={(id) => useRadio(id, 'base')}
            />
            <Slot
              label="Rover radio" help="gearRoverRadio" value={slots.roverRadio} options={radios}
              summary={radioSummary(limits.rover)} onPick={(id) => useRadio(id, 'rover')}
            />
            <Slot
              label="Base antenna" value={slots.baseAnt} options={antennas} drift={baseDrift}
              driftLabel={`${baseAnt ? baseAnt.name : 'Custom'}. Edited`}
              summary={`${p.baseKind === 'yagi' ? 'yagi' : 'sector'} · ${d1(p.baseGain)} dBi at ${baseAt} · ${d0(p.baseHBeam)}°×${d0(p.baseVBeam)}° · feed ${d1(p.baseCable)} dB`}
              onPick={(id) => useAntenna(id, 'base')}
              onSaveAs={() =>
                openLibrary({
                  tab: 'antennas',
                  draft: antennaFromBase(p, baseAnt ? `${baseAnt.name}, edited` : 'My base antenna'),
                })
              }
            />
            <Slot
              label="Rover antenna" value={slots.roverAnt} options={antennas} drift={roverDrift}
              driftLabel={`${roverAnt ? roverAnt.name : 'Custom'}. Edited`}
              summary={`${d1(p.roverGain)} dBi at ${roverAt} · ${d1(r.vRover)}° tall · feed ${d1(p.roverCable)} dB`}
              onPick={(id) => useAntenna(id, 'rover')}
              onSaveAs={() =>
                openLibrary({
                  tab: 'antennas',
                  draft: antennaFromRover(p, roverAnt ? `${roverAnt.name}, edited` : 'My rover antenna'),
                })
              }
            />
            <p className={styles.gearFoot}>
              The pair runs {r.streams}×{r.streams} to MCS{limits.maxMcs}.{' '}
              <button type="button" className={styles.linkBtn} onClick={() => openLibrary()}>
                Define or save gear…
              </button>
            </p>
            {/* The two ways a 2×2 radio ends up flying a 1×1 link. Both are
                properties of what is on the mast, so neither shows up anywhere
                on the radio's datasheet. */}
            {r.streamLimit === 'polarization' && (
              <p className={styles.gearWarn}>
                Both radios are {r.radioStreams}×{r.radioStreams}, but the antennas are
                single-polarised, so the two chains see the same channel and the link carries{' '}
                <b>one stream</b>. On a clear path that is half the rate for free. Cross-polarise
                one end. A dual-slant element, or the second panel mounted 90° over, to get it
                back.
              </p>
            )}
            {r.streamLimit === 'chains' && (
              <p className={styles.gearWarn}>
                One of these antennas has a single RF port, so the link runs{' '}
                <b>{r.streams}×{r.streams}</b> however many chains the radios have.
              </p>
            )}
            {r.ethBound && (
              <p className={styles.gearWarn}>
                The air would carry more than the wire will take: the slower of the two ports caps
                this link at <b>{d0(r.ethCap)} Mbps</b>. That is the Fast Ethernet bottleneck, and
                no antenna fixes it.
              </p>
            )}
            {roverAnt && roverAnt.kind !== 'omni' && (
              <p className={styles.gearWarn}>
                The rover element is modelled as a vertical omni, so only {roverAnt.name}'s gain is
                being used. Its azimuth pattern is not, and off its own band it will be scaled like
                an omni rather than like a {roverAnt.kind}.
              </p>
            )}
          </Box>

          <Box title="Geometry" badge={`${p.distance} m · ${p.baseH} m mast`}>
            <Slider help="distance" label="Distance" value={p.distance} min={50} max={2500} step={25} unit=" m" onChange={set('distance')} />
            <Slider help="baseH" label="Base mast height" value={p.baseH} min={1} max={12} step={0.5} unit=" m" onChange={set('baseH')}
                    hint="the single most powerful knob on this page" />
            <Slider help="roverH" label="Rover antenna height" value={p.roverH} min={0.2} max={3} step={0.1} unit=" m" onChange={set('roverH')} />
          </Box>

          <Box title="Base station" badge={`${p.baseTx} dBm · ${d1(p.baseGain)} dBi`}>
            <Slider help="baseTx" label="TX power" value={p.baseTx} min={5} max={Math.max(5, txCeil.base)} step={1} unit=" dBm"
                    onChange={set('baseTx')} hint={`max ${d0(txCeil.base)} dBm on ${BANDS[p.band].label}`} />
            {/* An omni in the base slot is modelled as the widest sector the
                model can draw, so its "azimuth beamwidth" is a stand-in and the
                D ≈ 41253/(H×V) check on it would be judging a number nobody
                claimed. The gain of an omni is checked by its toroid instead. */}
            <Slider help="baseGain" label={`Claimed gain at ${baseAt}`} value={p.baseGain} min={3} max={30} step={0.5} unit=" dBi" onChange={set('baseGain')}
                    hint={p.baseKind === 'omni'
                      ? `omni on the mast · ${d1(r.vBase)}° tall, round in azimuth`
                      : <SpecCheck claimed={p.baseGain} implied={r.impliedRef} />} />
            <Slider help="baseHBeam" label={`Azimuth beamwidth at ${baseAt}`} value={p.baseHBeam} min={8} max={180} step={2} unit="°" onChange={set('baseHBeam')} />
            <Slider help="baseVBeam" label={`Elevation beamwidth at ${baseAt}`} value={p.baseVBeam} min={4} max={120} step={1} unit="°" onChange={set('baseVBeam')}
                    hint={baseOffBand
                      ? `on ${BANDS[p.band].label} this ${p.baseKind === 'yagi' ? 'yagi' : 'aperture'} is ${d0(r.hBase)}°×${d0(r.vBase)}° and ${d1(r.baseGain)} dBi`
                      : null} />
            <Slider help="bearing" label="Rover off boresight" value={d0(r.bearingOff)}
                    min={0} max={90} step={1} unit="°" onChange={set('bearing')} disabled
                    hint="from the aim vs the rover bearing, so drag the map to change it" />
            <Slider help="downtilt" label="Mechanical downtilt" value={p.downtilt} min={0} max={15} step={1} unit="°" onChange={set('downtilt')} />
            <Slider help="baseCable" label="Coax loss" value={p.baseCable} min={0} max={20} step={0.2} unit=" dB" onChange={set('baseCable')}
                    hint="LMR-240 1 m ≈ 0.4 · LMR-400 25 m ≈ 18" />
          </Box>

          <Box title="Rover" badge={`${p.roverTx} dBm · ${d1(p.roverGain)} dBi`}>
            <Slider help="roverTx" label="TX power" value={p.roverTx} min={5} max={Math.max(5, txCeil.rover)} step={1} unit=" dBm"
                    onChange={set('roverTx')} hint={`max ${d0(txCeil.rover)} dBm here`} />
            <Slider help="roverGain" label={`Antenna gain at ${roverAt}`} value={p.roverGain} min={2} max={12} step={0.1} unit=" dBi" onChange={set('roverGain')}
                    hint={roverOffBand
                      ? `${d1(r.roverGain)} dBi on ${BANDS[p.band].label} · toroid is ${d1(r.vRover)}° tall`
                      : `toroid is ${d1(r.vRover)}° tall`} />
            <Slider help="tilt" label="Pitch on the slope" value={p.tilt} min={-45} max={45} step={1} unit="°" onChange={set('tilt')}
                    hint="negative pitches the toroid toward the base" />
            <Slider help="roverCable" label="Pigtail loss" value={p.roverCable} min={0} max={4} step={0.1} unit=" dB" onChange={set('roverCable')} />
          </Box>

          <Box title="Channel and rules" badge={`${BANDS[p.band].label} · ${p.width} MHz`}>
            <Pills help="band" label="Band" value={p.band} options={bandOpts}
                   onChange={(v) => setP((s) => reconcileLink({...s, band: v}))} />
            <Pills help="width" label="Channel width" value={p.width}
                   options={widthOpts.map((v, i, a) => [v, i === a.length - 1 ? `${v} MHz` : String(v)])}
                   onChange={set('width')} />
            {/* The radio will tune it and the rules will not let you fly it.
                Worth saying out loud on the page where you pick the number. */}
            {RULE_MAX_WIDTH[p.band] !== undefined && p.width > RULE_MAX_WIDTH[p.band] && (
              <p className={styles.gearWarn}>
                URC rule 3.b.v caps {BANDS[p.band].label} at{' '}
                <b>{RULE_MAX_WIDTH[p.band]} MHz</b> and confines it to one of three sub-bands. This
                channel models fine and cannot be flown.
              </p>
            )}
            <Pills help="reg" label="Part 15 mode" value={p.reg}
                   options={[['ptmp', 'multipoint'], ['p2p', 'point to point'], ['off', 'ignore']]} onChange={set('reg')} />
            <Slider help="interference" label="Interference vs thermal" value={p.interference} min={-20} max={25} step={1} unit=" dB"
                    onChange={set('interference')}
                    hint={`+${d1(10 * log10(1 + dbToLin(p.interference)))} dB noise floor · comp day +10 to +15`} />
            <label className={shared.check}>
              <input type="checkbox" checked={p.ackSet} onChange={() => set('ackSet')(!p.ackSet)} />
              <span>ACK timeout set for range</span>
              <Help id="ackSet" />
            </label>
          </Box>

          <Box title="Ground truth" badge={`aim ${d0(p.aim)}° · rover ${d0(p.heading)}°`}>
            <Slider help="aim" label="Sector aim" value={p.aim} min={0} max={359} step={1} unit="° from N"
                    onChange={set('aim')} hint="or drag the handle on the map" />
            <Slider help="heading" label="Rover heading" value={p.heading} min={0} max={359} step={1} unit="° from N"
                    onChange={set('heading')} hint="or drag the rover on the map" />
            <Slider help="baseE" label="Base east of centre" value={p.baseE} min={-2900} max={2900} step={25} unit=" m"
                    onChange={set('baseE')} />
            <Slider help="baseN" label="Base north of centre" value={p.baseN} min={-2900} max={2900} step={25} unit=" m"
                    onChange={set('baseN')} />
          </Box>
        </div>

        {/* top centre: the things you reach for, not the things you read */}
        <div className={styles.tc}>
          <select
            className={styles.select}
            aria-label="Try a scenario"
            value=""
            onChange={(e) => {
              if (PRESETS[e.target.value]) preset(PRESETS[e.target.value]);
            }}
          >
            <option value="">Try a scenario…</option>
            {Object.entries(PRESETS)
              .filter(([, patch]) => patch.site !== 'off')
              .map(([name]) => (
                <option key={name} value={name}>{name}</option>
              ))}
          </select>
          <button type="button" className={styles.primaryBtn} onClick={() => openLibrary()}>
            Gear library
          </button>
          <button type="button" className={styles.ghostBtn} onClick={pinCurrent}
                  title="Freeze this build as the A side of a comparison">
            {pinned ? 'Re-pin as A' : 'Pin as A'}
          </button>
          <button type="button" className={styles.ghostBtn} onClick={share}
                  title="Copy a link that reopens this exact bench">
            {copied ? 'Link copied' : 'Share'}
          </button>
          <button type="button" className={styles.ghostBtn} onClick={() => setShowInfo(true)}>
            How this works
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => {
              setP(STUDIO_DEFAULTS);
              setSlots(DEFAULT_SLOTS);
              setView({cx: 500, cy: 500, z: 1, layer: 'sat'});
            }}
          >
            Reset
          </button>
        </div>

        {/* The right rail, one column: budget, analysis, then the drawings on
            the floor. All three in the same flow, so they cannot overlap. */}
        <div className={styles.rr}>
          <div className={styles.budget}>
            <DirPanel title="Base → rover" sub="the joystick" dir={r.down} tone={CONTROL}
                      need={CONTROL_FLOOR} tag="of control" />
            <DirPanel title="Rover → base" sub="the cameras" dir={r.up} tone={VIDEO}
                      need={VIDEO_FLOOR} tag="of video" />
            <PathPanel r={r} sweep={sweep} />
          </div>

          <AnalysisCard tab={tab} setTab={setTab} tabs={analysisTabs}
                        open={analysisOpen} setOpen={setAnalysisOpen} />

          <div className={styles.br} hidden={analysisOpen}>
            <div className={`${styles.brRow} ${styles.brRowTop}`}>
              <div className={`${styles.chart} ${styles.chartSmall}`}><TopView p={p} r={r} /></div>
              <div className={`${styles.chart} ${styles.chartSmall}`}><PatternView p={p} r={r} /></div>
            </div>
            <div className={styles.brRow}>
              <div className={`${styles.chart} ${styles.chartWide}`}><SideView p={p} r={r} /></div>
              <div className={`${styles.chart} ${styles.chartWide}`}><RangeChart sweep={sweep} r={r} /></div>
            </div>
          </div>
        </div>

        {/* bottom left: what the map is showing, and the verdict */}
        <div className={styles.bl}>
          {(
            <div className={styles.mapTools}>
              {[['sat', 'Satellite'], ['both', 'Both'], ['topo', 'Contours']].map(([v, txt]) => (
                <button key={v} type="button"
                        className={`${shared.mapChip} ${view.layer === v ? shared.mapChipOn : ''}`}
                        aria-pressed={view.layer === v}
                        onClick={() => setView((w) => ({...w, layer: v}))}>
                  {txt}
                </button>
              ))}
              <span className={styles.toolGap} />
              {/* Coverage: the answer to "where can the rover go", which is a
                  different question from every other readout on this page. */}
              <button type="button"
                      className={`${shared.mapChip} ${cover.on ? shared.mapChipOn : ''}`}
                      aria-pressed={cover.on}
                      onClick={() => setCover((c) => ({...c, on: !c.on}))}>
                Coverage
              </button>
              {cover.on && (
                <select className={styles.miniSelect} value={cover.metric}
                        aria-label="What the coverage wash is showing"
                        onChange={(e) => setCover((c) => ({...c, metric: e.target.value}))}>
                  {Object.entries(COVER_METRICS).map(([k, m]) => (
                    <option key={k} value={k}>{m.label}</option>
                  ))}
                </select>
              )}
              {cover.on && coverage && (
                <CoverageLegend metric={cover.metric} workableKm2={coverage.workableKm2} />
              )}
              <span className={styles.toolGap} />
              <button type="button" className={shared.mapChip} aria-label="Zoom in"
                      onClick={() => zoomBy(2)} disabled={view.z >= 8}>+</button>
              <button type="button" className={shared.mapChip} aria-label="Zoom out"
                      onClick={() => zoomBy(0.5)} disabled={view.z <= 1}>−</button>
              <button type="button" className={shared.mapChip} aria-label="Reset the view"
                      onClick={() => setView((w) => ({...w, cx: 500, cy: 500, z: 1}))}
                      disabled={view.z === 1 && view.cx === 500 && view.cy === 500}>⟲</button>
              <span className={styles.scale} aria-label={`Scale bar, ${scaleBar.label}`}>
                <span className={styles.scaleLine} style={{width: `${scaleBar.vw}vw`}} />
                {scaleBar.label}
              </span>
              <span className={styles.mapHint}>
                north up · {view.z}× · {panText} · terrain {fine ? '11.7' : '30'} m
              </span>
            </div>
          )}
          <div className={`${shared.verdict} ${shared[verdict.cls]} ${styles.verdictBar}`}>
            {verdict.txt}<Help id="verdict" />
            <span className={styles.verdictAdvice}>
              Tighter direction: <b>{advice}</b><Help id="advice" />
            </span>
          </div>
        </div>

      </div>

      {showInfo && (
        <Overlay
          title="What the model actually computes"
          sub="The physics is real and the datasheet numbers are real. The Mbps are teaching values."
          onClose={() => setShowInfo(false)}
        >
          <InfoPanel gear />
        </Overlay>
      )}

      {lib && (
        <GearLibrary
          lib={lib0}
          onSaveItem={commitItem}
          onDeleteItem={removeItem}
          legacy={legacy}
          onMigrate={migrateLegacy}
          antennas={antennas}
          radios={radios}
          isBuiltin={(id) => STOCK_IDS.has(id)}
          slots={slots}
          params={p}
          onUseAntenna={useAntenna}
          onUseRadio={useRadio}
          onApplyBench={applyBench}
          onPreparePublish={preparePublish}
          onBenchLink={(b) => benchUrl({...STUDIO_DEFAULTS, ...b.params}, {...DEFAULT_SLOTS, ...b.slots})}
          onPublish={publishCurrent}
          initial={lib}
          onClose={() => setLib(null)}
        />
      )}
    </div>
  );
}
