import React, {useMemo, useState} from 'react';
import styles from './signalViews.module.css';
import {SITES} from './terrainModel';
import {
  BANDS,
  CONTROL_FLOOR,
  DEFAULTS,
  PRESETS,
  VIDEO_FLOOR,
  clamp,
  dbToLin,
  log10,
  solve,
  sweepRange,
} from './signalModel';
import {
  CONTROL,
  DirPanel,
  Help,
  InfoPanel,
  MapView,
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

// The doc-page embed: the link lab as it appears inline on the signals page,
// sized to a page column. Every view it draws is shared with the full-page
// studio at /signal-studio, which adds the gear library on top of it.

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

  // The heightmap gets better after the page has already drawn on it, so the
  // revision it reports is part of what the model depends on.
  const {rev: fineRev, fine} = useFineTerrain(p.site);

  const r = useMemo(() => solve(p, p.distance), [p, fineRev]);
  const onMap = p.site !== 'off';
  const siteInfo = SITES.find((s) => s.id === p.site) || SITES[0];

  const sweep = useMemo(() => sweepRange(p), [p, fineRev]);
  const verdict = verdictOf(r);
  const advice = adviceOf(r);

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
        <span className={styles.scenLbl}>Try a scenario:<Help id="scenario" /></span>
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
                    <b>{view.z}× zoom</b> · drag the map to pan, double-click or ctrl-scroll to
                    zoom, drag the square to move the base, the arrow to aim it, the circle to
                    place the rover · imagery sharpens as you zoom
                    {fine ? ' · terrain at 11.7 m' : ' · terrain at 30 m'}
                  </p>
                </div>
                <SiteCard p={p} r={r} site={siteInfo} />
              </>
            )}
          </div>
        </div>
        <div className={styles.sceneSide}>
          <TopView p={p} r={r} />
          <PatternView p={p} r={r} />
        </div>
      </div>

      <div className={`${styles.verdict} ${styles[verdict.cls]}`}>{verdict.txt}<Help id="verdict" /></div>

      <div className={styles.panels}>
        <DirPanel
          title="Base → rover" sub="the joystick" dir={r.down} tone={CONTROL}
          need={CONTROL_FLOOR} tag="of control"
        />
        <DirPanel
          title="Rover → base" sub="the cameras" dir={r.up} tone={VIDEO}
          need={VIDEO_FLOOR} tag="of video"
        />
        <PathPanel r={r} sweep={sweep} />
      </div>

      <RangeChart sweep={sweep} r={r} />

      <p className={styles.hintLine}>
        The tighter direction right now is <b>{advice}</b><Help id="advice" />
      </p>

      <div className={styles.controls}>
        <div className={styles.group}>
          <h6>Geometry</h6>
          <Slider help="distance" label="Distance" value={p.distance} min={50} max={2500} step={25} unit=" m" onChange={set('distance')} />
          <Slider help="baseH" label="Base mast height" value={p.baseH} min={1} max={12} step={0.5} unit=" m" onChange={set('baseH')}
                  hint="the single most powerful knob on this page" />
          <Slider help="roverH" label="Rover antenna height" value={p.roverH} min={0.2} max={3} step={0.1} unit=" m" onChange={set('roverH')} />
          <Slider help="ridgeH" label="Ridge height" value={p.ridgeH} min={0} max={20} step={0.5} unit=" m" onChange={set('ridgeH')}
                  disabled={onMap}
                  hint={onMap ? 'real terrain is driving the path instead' : '0 means clear desert'} />
          <Slider help="ridgeD" label="Ridge distance from base" value={p.ridgeD} min={25} max={2500} step={25} unit=" m"
                  onChange={set('ridgeD')} disabled={onMap || p.ridgeH === 0}
                  hint={!onMap && p.ridgeH > 0 && !r.ridgeInPath ? 'past the rover, so nothing is in the way' : null} />
        </div>

        <div className={styles.group}>
          <h6>Base station</h6>
          <Slider help="baseTx" label="TX power" value={p.baseTx} min={5} max={BANDS[p.band].txMax} step={1} unit=" dBm"
                  onChange={set('baseTx')} hint={`radio maxes out at ${BANDS[p.band].txMax} dBm on ${BANDS[p.band].label}`} />
          <Slider help="baseGain" label="Claimed gain at 5.8" value={p.baseGain} min={3} max={27} step={0.5} unit=" dBi" onChange={set('baseGain')}
                  hint={<SpecCheck claimed={p.baseGain} implied={r.impliedRef} />} />
          <Slider help="baseHBeam" label="Azimuth beamwidth at 5.8" value={p.baseHBeam} min={8} max={120} step={2} unit="°" onChange={set('baseHBeam')} />
          <Slider help="baseVBeam" label="Elevation beamwidth at 5.8" value={p.baseVBeam} min={4} max={90} step={1} unit="°" onChange={set('baseVBeam')}
                  hint={p.band === '2.4'
                    ? `on 2.4 GHz the same aperture is ${d0(r.hBase)}°×${d0(r.vBase)}° and ${d1(r.baseGain)} dBi`
                    : null} />
          <Slider help="bearing" label="Rover off boresight" value={onMap ? d0(r.bearingOff) : p.bearing}
                  min={0} max={90} step={1} unit="°" onChange={set('bearing')} disabled={onMap}
                  hint={onMap ? 'set by where the sector is aimed vs where the rover is' : null} />
          <Slider help="downtilt" label="Mechanical downtilt" value={p.downtilt} min={0} max={15} step={1} unit="°" onChange={set('downtilt')} />
          <Slider help="baseCable" label="Coax loss" value={p.baseCable} min={0} max={20} step={0.2} unit=" dB" onChange={set('baseCable')}
                  hint="1 m LMR-240 ≈ 0.4 · 25 m LMR-400 ≈ 18" />
        </div>

        <div className={styles.group}>
          <h6>Rover</h6>
          <Slider help="roverTx" label="TX power" value={p.roverTx} min={5} max={BANDS[p.band].txMax} step={1} unit=" dBm" onChange={set('roverTx')} />
          <Slider help="roverGain" label="Antenna gain at 5.8" value={p.roverGain} min={2} max={12} step={0.1} unit=" dBi" onChange={set('roverGain')}
                  hint={p.band === '2.4'
                    ? `${d1(r.roverGain)} dBi on 2.4 GHz · toroid is ${d1(r.vRover)}° tall`
                    : `toroid is ${d1(r.vRover)}° tall`} />
          <Slider help="tilt" label="Pitch on the slope" value={p.tilt} min={-45} max={45} step={1} unit="°" onChange={set('tilt')}
                  hint="negative pitches the toroid toward the base" />
          <Slider help="roverCable" label="Pigtail loss" value={p.roverCable} min={0} max={4} step={0.1} unit=" dB" onChange={set('roverCable')} />
        </div>

        <div className={styles.group}>
          <h6>Channel and rules</h6>
          <Pills help="band" label="Band" value={p.band} options={[['2.4', '2.4 GHz'], ['5.8', '5.8 GHz']]} onChange={setBand} />
          <Pills help="width" label="Channel width" value={p.width}
                 options={BANDS[p.band].widths.map((v, i, a) => [v, i === a.length - 1 ? `${v} MHz` : String(v)])}
                 onChange={set('width')} />
          <Pills help="reg" label="Part 15 mode" value={p.reg}
                 options={[['ptmp', 'multipoint'], ['p2p', 'point to point'], ['off', 'ignore']]} onChange={set('reg')} />
          <Slider help="interference" label="Interference vs thermal" value={p.interference} min={-20} max={25} step={1} unit=" dB"
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
        </div>
      </div>
    </div>
  );
}
