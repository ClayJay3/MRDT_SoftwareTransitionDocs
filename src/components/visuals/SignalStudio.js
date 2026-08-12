import React, {useEffect, useMemo, useState} from 'react';
import shared from './signalViews.module.css';
import styles from './SignalStudio.module.css';
import {SITES, SPAN_M} from './terrainModel';
import {
  BANDS,
  CONTROL_FLOOR,
  DEFAULTS,
  PRESETS,
  clamp,
  dbToLin,
  linkLimits,
  log10,
  REF_MHZ,
  solve,
  sweepRange,
  VIDEO_FLOOR,
} from './signalModel';
import {
  CONTROL,
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
  VIDEO,
  adviceOf,
  d0,
  d1,
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
  loadGear,
  newId,
  normalizeAntenna,
  normalizeRadioSpec,
  radioSummary,
  reconcileLink,
  roverMatches,
  saveGear,
} from './signalGear';

// The full-page version of the link lab. Same physics and the same views as the
// doc-page embed, but with the whole viewport to spend: controls down the left,
// the ground in the middle, the link budget down the right.
//
// What it adds is the gear library. On the doc page an antenna is four sliders
// you nudge and lose; here it is a part you define once, name, save and put
// back in the slot next week — and a radio stops being a fixed assumption of
// the model and becomes something you can type in off a datasheet.

const STOCK_IDS = new Set([...BUILTIN_ANTENNAS, ...BUILTIN_RADIOS].map((x) => x.id));

// Where to park the tripod on each site. A position means nothing across two
// different heightmaps, so switching terrain moves you to that site's own
// starting point rather than leaving you in whatever wash the coordinates
// happen to land in. Both are genuinely clear 1 km paths: the page should open
// on a link that works, so the first thing you break is something you chose.
const SITE_HOME = {
  off: {baseE: 0, baseN: 0, aim: 45, heading: 45},
  mdrs: {baseE: -300, baseN: -300, aim: 45, heading: 45},
  rolla: {baseE: -600, baseN: -300, aim: 345, heading: 345},
};

const TERRAINS = [['off', 'Flat + ridge'], ['mdrs', 'MDRS'], ['rolla', 'Rolla']];

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

const EMPTY_GEAR = {antennas: [], radios: [], setups: []};

// ------------------------------------------------------------------ boxes

// A control group as a collapsed card floating over the map. <details> rather
// than React state on purpose: it is keyboard-operable, it survives re-renders
// for free, and the browser already knows how to animate it.
//
// The summary carries the setting it holds, so the stack still reads as a
// status line when every box is shut — which is how it starts, because the map
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
  const [gear, setGear] = useState(EMPTY_GEAR);
  const [view, setView] = useState({cx: 500, cy: 500, z: 1, layer: 'sat'});
  const [showInfo, setShowInfo] = useState(false);
  const [lib, setLib] = useState(null); // {tab, draft} while the library is open
  // The map fills the window, so how far it can be panned depends on the shape
  // of the window. It reports that back rather than the page guessing.
  const [mapAr, setMapAr] = useState(1);

  // localStorage is a browser API, so it can only be read once we are in one.
  useEffect(() => setGear(loadGear()), []);

  const commitGear = (next) => {
    const clean = {
      antennas: next.antennas || [],
      radios: next.radios || [],
      setups: next.setups || [],
    };
    setGear(clean);
    saveGear(clean);

    // Editing a part that is sitting in a slot has to move the link you are
    // looking at, not just the library entry. Antennas are only refreshed when
    // the sliders still match the saved part — otherwise a save would throw
    // away edits you had not saved yet.
    const radioNow = (id) =>
      [...BUILTIN_RADIOS.map(normalizeRadioSpec), ...clean.radios].find((x) => x.id === id);
    const antNow = (id) =>
      [...BUILTIN_ANTENNAS.map(normalizeAntenna), ...clean.antennas].find((x) => x.id === id);
    setP((s) => {
      let out = s;
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
  };

  const antennas = useMemo(
    () => [...BUILTIN_ANTENNAS.map(normalizeAntenna), ...gear.antennas],
    [gear.antennas],
  );
  const radios = useMemo(
    () => [...BUILTIN_RADIOS.map(normalizeRadioSpec), ...gear.radios],
    [gear.radios],
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
      }),
    );

  const setSite = (v) => {
    setP((s) => ({...s, site: v, ...(SITE_HOME[v] || {})}));
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

  const saveSetup = (name) => {
    const entry = {
      id: newId('setup'),
      name,
      saved: new Date().toISOString(),
      summary: `${p.band} GHz · ${p.width} MHz · ${p.distance} m · ${
        p.site === 'off' ? 'flat + ridge' : (SITES.find((s) => s.id === p.site) || {}).name
      }`,
      params: p,
      slots,
    };
    commitGear({...gear, setups: [...gear.setups, entry]});
  };

  const applySetup = (entry) => {
    setP(reconcileLink({...STUDIO_DEFAULTS, ...entry.params}));
    setSlots({...DEFAULT_SLOTS, ...(entry.slots || {})});
    setView((w) => ({...w, cx: 500, cy: 500, z: 1}));
    setLib(null);
  };

  // --- the model

  // The bundled 30 m heightmap is what the first frame is drawn on; the 11.7 m
  // one arrives a moment later and the model has to be re-run against it.
  const {rev: fineRev, fine} = useFineTerrain(p.site);

  const r = useMemo(() => solve(p, p.distance), [p, fineRev]);
  const sweep = useMemo(() => sweepRange(p), [p, fineRev]);
  const limits = useMemo(() => linkLimits(p.baseRadio, p.roverRadio), [p.baseRadio, p.roverRadio]);

  const onMap = p.site !== 'off';
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
    : [[p.band, `${BANDS[p.band].label} — unsupported`]];
  const widthOpts = limits.widthsFor(p.band);

  const openLibrary = (init) => setLib(init || {tab: 'antennas'});

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
        {onMap ? (
          <MapView
            cover
            chrome={0.7}
            p={p} r={r} view={view} setView={setView}
            onChange={patch} onAspect={setMapAr}
          />
        ) : (
          <div className={styles.noMap}>
            <b>Flat desert, one ridge</b>
            <span>
              The synthetic world has no map. Put the link on real ground and the ridge sliders
              give way to a USGS heightmap you can drive the rover around.
            </span>
            <div className={shared.pills}>
              {SITES.map((s) => (
                <button key={s.id} type="button" className={shared.pill} onClick={() => setSite(s.id)}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ------------------------------------------- everything else floats on top */}
      <div className={`${styles.shell} ${shared.glass} ${shared.dense}`}>
        {/* top left: the bench, collapsed until you need it */}
        <div className={styles.tl}>
          <Box title="Terrain" badge={onMap ? siteInfo.name : 'Flat + ridge'} help="site">
            <Pills label="Ground" value={p.site} options={TERRAINS} onChange={setSite} />
            {onMap && <SiteCard p={p} r={r} site={siteInfo} />}
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
              driftLabel={`${baseAnt ? baseAnt.name : 'Custom'} — edited`}
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
              driftLabel={`${roverAnt ? roverAnt.name : 'Custom'} — edited`}
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
                one end — a dual-slant element, or the second panel mounted 90° over — to get it
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
                being used — its azimuth pattern is not, and off its own band it will be scaled like
                an omni rather than like a {roverAnt.kind}.
              </p>
            )}
          </Box>

          <Box title="Geometry" badge={`${p.distance} m · ${p.baseH} m mast`}>
            <Slider help="distance" label="Distance" value={p.distance} min={50} max={2500} step={25} unit=" m" onChange={set('distance')} />
            <Slider help="baseH" label="Base mast height" value={p.baseH} min={1} max={12} step={0.5} unit=" m" onChange={set('baseH')}
                    hint="the single most powerful knob on this page" />
            <Slider help="roverH" label="Rover antenna height" value={p.roverH} min={0.2} max={3} step={0.1} unit=" m" onChange={set('roverH')} />
            <Slider help="ridgeH" label="Ridge height" value={p.ridgeH} min={0} max={20} step={0.5} unit=" m" onChange={set('ridgeH')}
                    disabled={onMap}
                    hint={onMap ? 'real terrain drives the path' : '0 means clear desert'} />
            <Slider help="ridgeD" label="Ridge distance from base" value={p.ridgeD} min={25} max={2500} step={25} unit=" m"
                    onChange={set('ridgeD')} disabled={onMap || p.ridgeH === 0}
                    hint={!onMap && p.ridgeH > 0 && !r.ridgeInPath ? 'past the rover, so nothing is in the way' : null} />
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
            <Slider help="bearing" label="Rover off boresight" value={onMap ? d0(r.bearingOff) : p.bearing}
                    min={0} max={90} step={1} unit="°" onChange={set('bearing')} disabled={onMap}
                    hint={onMap ? 'from the aim vs the rover bearing' : null} />
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
                    onChange={set('aim')} disabled={!onMap}
                    hint={onMap ? 'or drag the handle on the map' : 'pick a site to enable'} />
            <Slider help="heading" label="Rover heading" value={p.heading} min={0} max={359} step={1} unit="° from N"
                    onChange={set('heading')} disabled={!onMap}
                    hint={onMap ? 'or drag the rover on the map' : null} />
            <Slider help="baseE" label="Base east of centre" value={p.baseE} min={-2900} max={2900} step={25} unit=" m"
                    onChange={set('baseE')} disabled={!onMap} />
            <Slider help="baseN" label="Base north of centre" value={p.baseN} min={-2900} max={2900} step={25} unit=" m"
                    onChange={set('baseN')} disabled={!onMap} />
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
            {Object.keys(PRESETS).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
          <button type="button" className={styles.primaryBtn} onClick={() => openLibrary()}>
            Gear library
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

        {/* top right: the link budget, side by side */}
        <div className={styles.tr}>
          <DirPanel title="Base → rover" sub="the joystick" dir={r.down} tone={CONTROL}
                    need={CONTROL_FLOOR} tag="of control" />
          <DirPanel title="Rover → base" sub="the cameras" dir={r.up} tone={VIDEO}
                    need={VIDEO_FLOOR} tag="of video" />
          <PathPanel r={r} sweep={sweep} />
        </div>

        {/* bottom left: what the map is showing, and the verdict */}
        <div className={styles.bl}>
          {onMap && (
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

        {/* bottom right: the drawings, small ones above the wide ones */}
        <div className={styles.br}>
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
          gear={gear}
          setGear={commitGear}
          antennas={antennas}
          radios={radios}
          isBuiltin={(id) => STOCK_IDS.has(id)}
          slots={slots}
          params={p}
          onUseAntenna={useAntenna}
          onUseRadio={useRadio}
          onApplySetup={applySetup}
          onSaveSetup={saveSetup}
          initial={lib}
          onClose={() => setLib(null)}
        />
      )}
    </div>
  );
}
