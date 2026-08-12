import React, {useMemo, useState} from 'react';
import shared from './signalViews.module.css';
import styles from './SignalStudio.module.css';
import {Overlay, SpecCheck, d1} from './signalViews';
import {BANDS, PHY_FAMILIES, dirFromBeamwidth, omniVBeam} from './signalModel';
import {
  ALL_WIDTHS,
  BAND_IDS,
  antennaSummary,
  exportGear,
  importGear,
  newId,
  normalizeAntenna,
  normalizeRadioSpec,
  radioSummary,
} from './signalGear';

// The gear library: define a part, save it, get it back later. Everything the
// studio knows about hardware is either a built-in (code, so it improves when
// the page does) or something typed in here and kept in this browser.
//
// The editors deliberately ask for the numbers a datasheet actually prints —
// gain and two beamwidths, TX power and two sensitivity anchors — rather than
// the internals the model derives from them.

const clampNum = (v, lo, hi, fallback) => {
  const n = +v;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

function Field({label, hint, children}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLbl}>{label}</span>
      {children}
      {hint && <span className={styles.fieldHint}>{hint}</span>}
    </label>
  );
}

function NumField({label, hint, value, min, max, step, unit, onChange}) {
  return (
    <Field label={unit ? `${label} (${unit})` : label} hint={hint}>
      <input
        className={styles.input}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step ?? 0.1}
        onChange={(e) => onChange(e.target.value === '' ? '' : +e.target.value)}
      />
    </Field>
  );
}

// ------------------------------------------------------------ antenna form

const KIND_HINT = {
  sector: 'Two dimensions of aperture: away from its own band both beamwidths scale with wavelength and the gain moves by 20log₁₀ of the ratio.',
  yagi: 'End-fire, so gain follows boom length in wavelengths: off its own band it gives up only 10log₁₀, and the beam broadens by the square root of the ratio.',
  omni: 'One dimension of aperture: the toroid height follows from the gain, so there is nothing to type. Round in azimuth on every band.',
};

// A one-port antenna has no second polarization to be, whatever the draft says,
// so both the pill state and the stream count read through the same rule the
// model uses.
const polOf = (d) => (clampNum(d.chains, 1, 4, 2) < 2 ? 'v' : d.pol === 'v' ? 'v' : 'x');
const rank = (d) => (polOf(d) === 'x' ? clampNum(d.chains, 1, 4, 2) : 1);

function AntennaEditor({draft, setDraft, onSave, onCancel, error}) {
  const omni = draft.kind === 'omni';
  const gain = clampNum(draft.gain, -3, 30, 12);
  const ref = BANDS[draft.ref] ? draft.ref : '5.8';
  const refLabel = BANDS[ref].label;
  const implied = omni ? gain : dirFromBeamwidth(
    clampNum(draft.hBeam, 3, 180, 30),
    clampNum(draft.vBeam, 3, 120, 30),
  );

  return (
    <div className={styles.editor}>
      <Field label="Name">
        <input
          className={styles.input}
          type="text"
          value={draft.name}
          maxLength={60}
          placeholder="e.g. SignalPlus panel, derated"
          onChange={(e) => setDraft({...draft, name: e.target.value})}
        />
      </Field>

      <Field label="Type" hint={KIND_HINT[draft.kind] || KIND_HINT.sector}>
        <div className={shared.pills}>
          {[['sector', 'Sector / panel'], ['yagi', 'Yagi'], ['omni', 'Omni']].map(([v, txt]) => (
            <button
              key={v}
              type="button"
              className={`${shared.pill} ${draft.kind === v ? shared.pillOn : ''}`}
              onClick={() => setDraft({...draft, kind: v})}
            >
              {txt}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Numbers quoted at"
        hint="The band the datasheet measured. Everything below is read as being true there, and scaled from there if the link runs somewhere else."
      >
        <div className={shared.pills}>
          {BAND_IDS.map((id) => (
            <button
              key={id}
              type="button"
              className={`${shared.pill} ${ref === id ? shared.pillOn : ''}`}
              onClick={() => setDraft({...draft, ref: id})}
            >
              {BANDS[id].label}
            </button>
          ))}
        </div>
      </Field>

      <div className={styles.formRow}>
        <NumField
          label={`Gain at ${refLabel}`} unit="dBi" value={draft.gain} min={-3} max={30} step={0.1}
          onChange={(v) => setDraft({...draft, gain: v})}
        />
        <NumField
          label="Feed / jumper loss" unit="dB" value={draft.feed} min={0} max={25} step={0.1}
          hint="1 m LMR-240 ≈ 0.4 · 25 m LMR-400 ≈ 18"
          onChange={(v) => setDraft({...draft, feed: v})}
        />
      </div>

      {/* The two specs that decide whether a 2×2 radio flies a 2×2 link. Count
          the connectors, then ask what is behind them. */}
      <div className={styles.formRow}>
        <NumField
          label="RF ports (chains)" value={draft.chains} min={1} max={4} step={1}
          hint="One connector is one chain. Two of the same antenna side by side is two."
          onChange={(v) => setDraft({...draft, chains: v})}
        />
        <Field
          label="Polarization"
          hint="Cross-polarised ports see different channels and carry different streams. Same-polarity ports see one channel twice."
        >
          <div className={shared.pills}>
            {[['x', 'Cross-pol'], ['v', 'Single pol']].map(([v, txt]) => (
              <button
                key={v}
                type="button"
                disabled={clampNum(draft.chains, 1, 4, 2) < 2}
                className={`${shared.pill} ${polOf(draft) === v ? shared.pillOn : ''}`}
                onClick={() => setDraft({...draft, pol: v})}
              >
                {txt}
              </button>
            ))}
          </div>
        </Field>
      </div>
      <p className={styles.derived}>
        {rank(draft) > 1 ? (
          <>Carries <b>{rank(draft)} spatial streams</b> on a clear path.</>
        ) : (
          <>
            Carries <b>one spatial stream</b> on a clear path
            {clampNum(draft.chains, 1, 4, 2) > 1
              ? ' — the second chain is a copy of the first, not a second channel.'
              : '.'}
          </>
        )}
      </p>

      {omni ? (
        <p className={styles.derived}>
          At {d1(gain)} dBi the toroid is <b>{d1(omniVBeam(gain))}° tall</b> on {refLabel}. Every
          octave down from there costs 3 dB and widens it by the same ratio.
        </p>
      ) : (
        <>
          <div className={styles.formRow}>
            <NumField
              label="Azimuth beamwidth" unit="°" value={draft.hBeam} min={3} max={180} step={1}
              onChange={(v) => setDraft({...draft, hBeam: v})}
            />
            <NumField
              label="Elevation beamwidth" unit="°" value={draft.vBeam} min={3} max={120} step={1}
              onChange={(v) => setDraft({...draft, vBeam: v})}
            />
          </div>
          <p className={styles.derived}>
            <SpecCheck claimed={gain} implied={implied} />
            {' · '}D ≈ 41253 / (H° × V°) is a ceiling, not a suggestion — and it is judged
            {' '}at {refLabel}, where these numbers were measured.
          </p>
        </>
      )}

      <Field label="Note" hint="Price, part number, where the numbers came from — anything the next person needs.">
        <textarea
          className={styles.input}
          rows={2}
          maxLength={240}
          value={draft.note}
          onChange={(e) => setDraft({...draft, note: e.target.value})}
        />
      </Field>

      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.editorBtns}>
        <button type="button" className={styles.primaryBtn} onClick={onSave}>Save antenna</button>
        <button type="button" className={styles.ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- radio form

function RadioEditor({draft, setDraft, onSave, onCancel, error}) {
  const fam = PHY_FAMILIES[draft.family] || PHY_FAMILIES.ax;
  const topMcs = fam.phy.length - 1;
  const setBand = (id, patch) =>
    setDraft({...draft, bands: {...draft.bands, [id]: {...draft.bands[id], ...patch}}});
  const toggleBand = (id) => {
    const bands = {...draft.bands};
    if (bands[id]) delete bands[id];
    else bands[id] = {txMax: 25, widths: [20, 40], sens0: -96, sensTop: -70};
    setDraft({...draft, bands});
  };

  return (
    <div className={styles.editor}>
      <Field label="Name">
        <input
          className={styles.input}
          type="text"
          value={draft.name}
          maxLength={60}
          placeholder="e.g. NetMetal ax, 900 MHz card"
          onChange={(e) => setDraft({...draft, name: e.target.value})}
        />
      </Field>

      <Field label="PHY generation" hint={`Sets the rate ladder: MCS0 to MCS${topMcs} at ${fam.phy[topMcs]} Mbps per stream on 20 MHz.`}>
        <div className={shared.pills}>
          {Object.entries(PHY_FAMILIES).map(([id, f]) => (
            <button
              key={id}
              type="button"
              className={`${shared.pill} ${draft.family === id ? shared.pillOn : ''}`}
              onClick={() => setDraft({...draft, family: id})}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Field>

      <div className={styles.formRow}>
        <NumField
          label="Spatial streams" value={draft.streams} min={1} max={4} step={1}
          hint="The pair runs at the weaker end's stream count — and at the antennas', which is usually lower."
          onChange={(v) => setDraft({...draft, streams: v})}
        />
        <NumField
          label="TX backoff at the top rung" unit="dB" value={draft.backoffTop} min={0} max={20} step={0.5}
          hint="Every radio turns itself down as the constellation gets denser. The ax does 8 dB."
          onChange={(v) => setDraft({...draft, backoffTop: v})}
        />
      </div>

      <Field
        label="Ethernet port"
        hint="The wire behind the radio. On the M-series this is the binding constraint long before the air is."
      >
        <div className={shared.pills}>
          {[[100, '10/100'], [1000, 'Gigabit'], [2500, '2.5G']].map(([v, txt]) => (
            <button
              key={v}
              type="button"
              className={`${shared.pill} ${clampNum(draft.eth, 1, 10000, 1000) === v ? shared.pillOn : ''}`}
              onClick={() => setDraft({...draft, eth: v})}
            >
              {txt}
            </button>
          ))}
        </div>
      </Field>

      <div className={styles.bandGrid}>
        {BAND_IDS.map((id) => {
          const b = draft.bands[id];
          return (
            <div key={id} className={`${styles.bandCard} ${b ? '' : styles.bandOff}`}>
              <label className={styles.bandHead}>
                <input type="checkbox" checked={Boolean(b)} onChange={() => toggleBand(id)} />
                <b>{BANDS[id].label}</b>
              </label>
              {b && (
                <>
                  <NumField
                    label="Max TX power" unit="dBm" value={b.txMax} min={0} max={40} step={1}
                    onChange={(v) => setBand(id, {txMax: v})}
                  />
                  <Field label="Channel widths (MHz)">
                    <div className={shared.pills}>
                      {ALL_WIDTHS.map((w) => {
                        const on = (b.widths || []).includes(w);
                        return (
                          <button
                            key={w}
                            type="button"
                            className={`${shared.pill} ${on ? shared.pillOn : ''}`}
                            onClick={() =>
                              setBand(id, {
                                widths: on
                                  ? (b.widths || []).filter((x) => x !== w)
                                  : [...(b.widths || []), w].sort((x, y) => x - y),
                              })
                            }
                          >
                            {w}
                          </button>
                        );
                      })}
                    </div>
                  </Field>
                  <div className={styles.formRow}>
                    <NumField
                      label="Sensitivity, MCS0" unit="dBm" value={b.sens0} min={-110} max={-50} step={1}
                      onChange={(v) => setBand(id, {sens0: v})}
                    />
                    <NumField
                      label={`Sensitivity, MCS${topMcs}`} unit="dBm" value={b.sensTop} min={-110} max={-40} step={1}
                      onChange={(v) => setBand(id, {sensTop: v})}
                    />
                  </div>
                  <p className={styles.derived}>
                    Both quoted at 20 MHz. The curve between them keeps the shape of a real
                    {' '}{fam.label} receiver; narrower channels move it by 10log₁₀(BW/20).
                  </p>
                </>
              )}
            </div>
          );
        })}
      </div>

      <Field label="Note">
        <textarea
          className={styles.input}
          rows={2}
          maxLength={240}
          value={draft.note}
          onChange={(e) => setDraft({...draft, note: e.target.value})}
        />
      </Field>

      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.editorBtns}>
        <button type="button" className={styles.primaryBtn} onClick={onSave}>Save radio</button>
        <button type="button" className={styles.ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ shell

const BLANK_ANTENNA = {
  name: '', kind: 'sector', ref: '5.8', gain: 15, hBeam: 30, vBeam: 30, feed: 0.4,
  chains: 2, pol: 'x', note: '',
};
const BLANK_RADIO = {
  name: '', family: 'ax', streams: 2, backoffTop: 8, eth: 1000,
  bands: {'5.8': {txMax: 25, widths: [20, 40], sens0: -96, sensTop: -70}},
  note: '',
};

export default function GearLibrary({
  gear,
  setGear,
  antennas,
  radios,
  isBuiltin,
  slots,
  params,
  onUseAntenna,
  onUseRadio,
  onApplySetup,
  onSaveSetup,
  initial,
  onClose,
}) {
  const [tab, setTab] = useState(initial?.tab || 'antennas');
  const [draft, setDraft] = useState(initial?.draft || null);
  const [draftKind, setDraftKind] = useState(initial?.draft ? initial.tab : null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [setupName, setSetupName] = useState('');
  const [io, setIo] = useState(null); // 'export' | 'import'
  const [pasted, setPasted] = useState('');

  const exported = useMemo(() => (io === 'export' ? exportGear(gear) : ''), [io, gear]);

  const startAntenna = (base) => {
    setDraftKind('antennas');
    setDraft({...BLANK_ANTENNA, ...base});
    setError('');
  };
  const startRadio = (base) => {
    setDraftKind('radios');
    setDraft({...BLANK_RADIO, ...base});
    setError('');
  };

  function saveAntenna() {
    if (!draft.name.trim()) return setError('Give it a name you will recognise in a picker.');
    const item = normalizeAntenna({...draft, name: draft.name.trim(), id: draft.id || newId('ant')});
    const exists = gear.antennas.some((a) => a.id === item.id);
    setGear({
      ...gear,
      antennas: exists ? gear.antennas.map((a) => (a.id === item.id ? item : a)) : [...gear.antennas, item],
    });
    setDraft(null);
    setStatus(`Saved “${item.name}”.`);
    return undefined;
  }

  function saveRadio() {
    if (!draft.name.trim()) return setError('Give it a name you will recognise in a picker.');
    if (!Object.keys(draft.bands || {}).length) return setError('A radio needs at least one band.');
    const item = normalizeRadioSpec({...draft, name: draft.name.trim(), id: draft.id || newId('radio')});
    const exists = gear.radios.some((r) => r.id === item.id);
    setGear({
      ...gear,
      radios: exists ? gear.radios.map((r) => (r.id === item.id ? item : r)) : [...gear.radios, item],
    });
    setDraft(null);
    setStatus(`Saved “${item.name}”.`);
    return undefined;
  }

  const removeAntenna = (id) =>
    setGear({...gear, antennas: gear.antennas.filter((a) => a.id !== id)});
  const removeRadio = (id) => setGear({...gear, radios: gear.radios.filter((r) => r.id !== id)});
  const removeSetup = (id) => setGear({...gear, setups: gear.setups.filter((s) => s.id !== id)});

  function doImport() {
    try {
      const {added, ...next} = importGear(pasted, gear);
      setGear(next);
      setStatus(
        `Imported ${added.antennas} antenna(s), ${added.radios} radio(s), ${added.setups} setup(s).`,
      );
      setPasted('');
      setIo(null);
    } catch (e) {
      setError(`That did not import: ${e.message}`);
    }
  }

  function onFile(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPasted(String(reader.result || ''));
    reader.readAsText(file);
  }

  function download() {
    const blob = new Blob([exported], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'mrdt-signal-gear.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  const listRow = (item, kind) => {
    const stock = isBuiltin(item.id);
    const inUse = Object.values(slots).includes(item.id);
    return (
      <li key={item.id} className={`${styles.row} ${inUse ? styles.rowOn : ''}`}>
        <div className={styles.rowMain}>
          <span className={styles.rowName}>
            {item.name}
            {stock && <span className={styles.tag}>stock</span>}
            {inUse && <span className={`${styles.tag} ${styles.tagOn}`}>in use</span>}
          </span>
          <span className={styles.rowSub}>
            {kind === 'antennas' ? antennaSummary(item) : radioSummary(item)}
          </span>
          {item.note && <span className={styles.rowNote}>{item.note}</span>}
        </div>
        <div className={styles.rowBtns}>
          {kind === 'antennas' ? (
            <>
              <button type="button" className={styles.miniBtn} onClick={() => onUseAntenna(item.id, 'base')}>
                → base
              </button>
              <button type="button" className={styles.miniBtn} onClick={() => onUseAntenna(item.id, 'rover')}>
                → rover
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.miniBtn} onClick={() => onUseRadio(item.id, 'base')}>
                → base
              </button>
              <button type="button" className={styles.miniBtn} onClick={() => onUseRadio(item.id, 'rover')}>
                → rover
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.miniBtn}
            onClick={() =>
              kind === 'antennas'
                ? startAntenna({...item, id: undefined, name: `${item.name} copy`})
                : startRadio({...item, id: undefined, name: `${item.name} copy`})
            }
          >
            Duplicate
          </button>
          {!stock && (
            <>
              <button
                type="button"
                className={styles.miniBtn}
                onClick={() => (kind === 'antennas' ? startAntenna(item) : startRadio(item))}
              >
                Edit
              </button>
              <button
                type="button"
                className={`${styles.miniBtn} ${styles.miniDanger}`}
                onClick={() => (kind === 'antennas' ? removeAntenna(item.id) : removeRadio(item.id))}
              >
                Delete
              </button>
            </>
          )}
        </div>
      </li>
    );
  };

  const TABS = [
    ['antennas', `Antennas (${antennas.length})`],
    ['radios', `Radios (${radios.length})`],
    ['setups', `Setups (${gear.setups.length})`],
  ];

  return (
    <Overlay
      wide
      title="Gear library"
      sub="Built-in parts ship with the page. Anything you define is saved in this browser and can be exported."
      onClose={onClose}
    >
      <div className={styles.libTabs}>
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`${styles.tabBtn} ${tab === id ? styles.tabOn : ''}`}
            onClick={() => {
              setTab(id);
              setDraft(null);
              setError('');
            }}
          >
            {label}
          </button>
        ))}
        <span className={styles.libSpacer} />
        {tab === 'antennas' && (
          <button type="button" className={styles.primaryBtn} onClick={() => startAntenna({})}>
            + New antenna
          </button>
        )}
        {tab === 'radios' && (
          <button type="button" className={styles.primaryBtn} onClick={() => startRadio({})}>
            + New radio
          </button>
        )}
      </div>

      {status && <p className={styles.status}>{status}</p>}

      {draft && draftKind === 'antennas' && tab === 'antennas' && (
        <AntennaEditor
          draft={draft} setDraft={setDraft} error={error}
          onSave={saveAntenna} onCancel={() => setDraft(null)}
        />
      )}
      {draft && draftKind === 'radios' && tab === 'radios' && (
        <RadioEditor
          draft={draft} setDraft={setDraft} error={error}
          onSave={saveRadio} onCancel={() => setDraft(null)}
        />
      )}

      {tab === 'antennas' && (
        <ul className={styles.rows}>{antennas.map((a) => listRow(a, 'antennas'))}</ul>
      )}
      {tab === 'radios' && <ul className={styles.rows}>{radios.map((r) => listRow(r, 'radios'))}</ul>}

      {tab === 'setups' && (
        <>
          <div className={styles.saveRow}>
            <input
              className={styles.input}
              type="text"
              maxLength={60}
              placeholder="Name this setup, e.g. MDRS ridge, 2.4 fallback"
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => {
                if (!setupName.trim()) return setError('Name it first.');
                onSaveSetup(setupName.trim());
                setSetupName('');
                setStatus('Setup saved.');
                setError('');
                return undefined;
              }}
            >
              Save current setup
            </button>
          </div>
          <p className={styles.derived}>
            A setup is the whole bench: both radios, both antennas, the terrain, where the base is
            parked, where it is aimed and every slider. Recalling one puts all of it back.
          </p>
          {error && <p className={styles.error}>{error}</p>}
          <ul className={styles.rows}>
            {gear.setups.map((s) => (
              <li key={s.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>{s.name}</span>
                  <span className={styles.rowSub}>
                    {s.summary} · saved {new Date(s.saved).toLocaleDateString()}
                  </span>
                </div>
                <div className={styles.rowBtns}>
                  <button type="button" className={styles.miniBtn} onClick={() => onApplySetup(s)}>
                    Recall
                  </button>
                  <button
                    type="button"
                    className={`${styles.miniBtn} ${styles.miniDanger}`}
                    onClick={() => removeSetup(s.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
            {!gear.setups.length && (
              <li className={styles.empty}>
                Nothing saved yet. The link you have on screen right now — {params.band} GHz at
                {' '}{params.distance} m — is one button away from being here.
              </li>
            )}
          </ul>
        </>
      )}

      <div className={styles.libFoot}>
        <button type="button" className={styles.ghostBtn} onClick={() => setIo(io === 'export' ? null : 'export')}>
          Export
        </button>
        <button type="button" className={styles.ghostBtn} onClick={() => setIo(io === 'import' ? null : 'import')}>
          Import
        </button>
        <span className={styles.libNote}>
          Saved in this browser only — export the file to move it to another machine or into the repo.
        </span>
      </div>

      {io === 'export' && (
        <div className={styles.ioBox}>
          <textarea className={styles.input} rows={6} readOnly value={exported} />
          <button type="button" className={styles.primaryBtn} onClick={download}>
            Download .json
          </button>
        </div>
      )}
      {io === 'import' && (
        <div className={styles.ioBox}>
          <textarea
            className={styles.input}
            rows={6}
            placeholder="Paste an exported gear file here"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className={styles.editorBtns}>
            <input type="file" accept="application/json,.json" onChange={onFile} />
            <button type="button" className={styles.primaryBtn} onClick={doImport} disabled={!pasted.trim()}>
              Merge into my library
            </button>
          </div>
          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}
    </Overlay>
  );
}
