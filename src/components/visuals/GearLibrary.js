import React, {useMemo, useState} from 'react';
import shared from './signalViews.module.css';
import styles from './SignalStudio.module.css';
import {Overlay, SpecCheck, d1} from './signalViews';
import {BANDS, PHY_FAMILIES, dirFromBeamwidth, omniVBeam} from './signalModel';
import {BENCHES, benchSource, searchBenches} from '../../data/benches';
import {
  ALL_WIDTHS,
  BAND_IDS,
  antennaPayload,
  antennaSummary,
  normalizeAntenna,
  normalizeRadioSpec,
  radioPayload,
  radioSummary,
} from './signalGear';

// The gear library: define a part, save it, and everyone gets it back later.
// Everything the studio knows about hardware is either a built-in (code, so it
// improves when the page does) or something typed in here and stored on the
// gear service, shared with everyone who can see the page.
//
// The editors deliberately ask for the numbers a datasheet actually prints:
// gain and two beamwidths, TX power and two sensitivity anchors, rather than
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
              ? '. The second chain is a copy of the first, not a second channel.'
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
            {' · '}D ≈ 41253 / (H° × V°) is a ceiling, not a suggestion, and it is judged
            {' '}at {refLabel}, where these numbers were measured.
          </p>
        </>
      )}

      <div className={styles.formRow}>
        <NumField
          label="Price each" unit="$" value={draft.price} min={0} max={100000} step={1}
          hint="0 means unpriced, and drops out of the build total instead of making it read low."
          onChange={(v) => setDraft({...draft, price: v})}
        />
        <NumField
          label="How many per side" value={draft.qty} min={1} max={8} step={1}
          hint="Two omnis on a rover is two of this part, and the build total should say so."
          onChange={(v) => setDraft({...draft, qty: v})}
        />
      </div>

      <Field label="Note" hint="Part number, where the numbers came from. Anything the next person needs.">
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
          hint="The pair runs at the weaker end's stream count, and at the antennas', which is usually lower."
          onChange={(v) => setDraft({...draft, streams: v})}
        />
        <NumField
          label="TX backoff at the top rung" unit="dB" value={draft.backoffTop} min={0} max={20} step={0.5}
          hint="Every radio turns itself down as the constellation gets denser. The ax does 8 dB."
          onChange={(v) => setDraft({...draft, backoffTop: v})}
        />
      </div>

      <NumField
        label="Price each" unit="$" value={draft.price} min={0} max={100000} step={1}
        hint="0 means unpriced. Two radios per link, one at each end."
        onChange={(v) => setDraft({...draft, price: v})}
      />

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
  chains: 2, pol: 'x', price: 0, qty: 1, note: '',
};
const BLANK_RADIO = {
  name: '', family: 'ax', streams: 2, backoffTop: 8, eth: 1000, price: 0,
  bands: {'5.8': {txMax: 25, widths: [20, 40], sens0: -96, sensTop: -70}},
  note: '',
};

export default function GearLibrary({
  lib,
  onSaveItem,
  onDeleteItem,
  legacy,
  onMigrate,
  antennas,
  radios,
  isBuiltin,
  slots,
  params,
  onUseAntenna,
  onUseRadio,
  onApplySetup,
  onSaveSetup,
  onApplyBench,
  onPreparePublish,
  onBenchLink,
  onPublish,
  onDeleteBench,
  bench,
  initial,
  onClose,
}) {
  const [tab, setTab] = useState(initial?.tab || 'antennas');
  const [draft, setDraft] = useState(initial?.draft || null);
  const [draftKind, setDraftKind] = useState(initial?.draft ? initial.tab : null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [setupName, setSetupName] = useState('');
  // The public catalogue: a search box over benches that ship with the site,
  // and the draft entry for adding one of your own to it.
  const [find, setFind] = useState('');
  const [pub, setPub] = useState(null);
  const [pubName, setPubName] = useState('');
  const [pubNote, setPubNote] = useState('');
  const [busy, setBusy] = useState(false);


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

  async function saveAntenna() {
    if (!draft.name.trim()) return setError('Give it a name you will recognise in a picker.');
    setBusy(true);
    const item = normalizeAntenna({...draft, name: draft.name.trim()});
    const res = await onSaveItem('antennas', {...antennaPayload(item), id: draft.id});
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDraft(null);
    setStatus(`Saved “${item.name}” for everyone.`);
    return undefined;
  }

  async function saveRadio() {
    if (!draft.name.trim()) return setError('Give it a name you will recognise in a picker.');
    if (!Object.keys(draft.bands || {}).length) return setError('A radio needs at least one band.');
    setBusy(true);
    const item = normalizeRadioSpec({...draft, name: draft.name.trim()});
    const res = await onSaveItem('radios', {...radioPayload(item), id: draft.id});
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setDraft(null);
    setStatus(`Saved “${item.name}” for everyone.`);
    return undefined;
  }

  const removePart = async (kind, id) => {
    const res = await onDeleteItem(kind, id);
    if (!res.ok) setError(res.error);
    else setStatus('Removed.');
  };

  const listRow = (item, kind) => {
    const stock = isBuiltin(item.id);
    const inUse = Object.values(slots).includes(item.id);
    // The service refuses an edit or a delete on someone else's part anyway.
    // Not offering the buttons is the difference between a rule and a trap.
    const mine = !stock && (lib.moderator || (lib.you && item.by === lib.you));
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
          {!stock && (
            <span className={styles.rowSub}>
              saved by {item.by || 'someone'}{item.added ? ` on ${item.added}` : ''}
              {item.edited ? `, edited ${item.edited}` : ''}
            </span>
          )}
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
          {mine && (
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
                onClick={() => removePart(kind, item.id)}
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
    ['published', `Benches (${lib.library.benches.length + BENCHES.length})`],
  ];

  const allBenches = [
    ...lib.library.benches,
    ...BENCHES.map((b) => ({...b, origin: 'builtin'})),
  ];
  const found = searchBenches(allBenches, find);

  return (
    <Overlay
      wide
      title="Gear library"
      sub="Built-in parts ship with the site. Everything you save is stored on the server and shared with everyone who opens the studio."
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

      {tab === 'published' && (
        <>
          <div className={styles.saveRow}>
            <input
              className={styles.input}
              type="search"
              placeholder="Search by name, gear, band, site, tag or who published it"
              aria-label="Search published benches"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          </div>

          {/* Publishing is a name and a button. Everything else about the bench
              is already on screen behind this overlay. */}
          <div className={styles.saveRow}>
            <input
              className={styles.input}
              type="text"
              maxLength={60}
              placeholder="Name it, e.g. MDRS ridge, 2.4 fallback"
              value={pubName}
              onChange={(e) => setPubName(e.target.value)}
            />
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || !lib.ok}
              onClick={async () => {
                setBusy(true);
                setError('');
                const res = await onPublish(pubName, pubNote);
                setBusy(false);
                if (res.ok) {
                  setPubName('');
                  setPubNote('');
                  setStatus(`Published “${res.item.name}”.`);
                } else {
                  setError(res.error);
                }
              }}
            >
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          </div>
          <input
            className={styles.input}
            type="text"
            maxLength={300}
            placeholder="One line on what it is for and what to look at (optional)"
            value={pubNote}
            onChange={(e) => setPubNote(e.target.value)}
          />

          <p className={styles.derived}>
            A bench is a whole setup: both radios, both antennas, the terrain, where the base is
            parked, where it is aimed and every slider. Publishing one shares it with everyone who
            opens the studio. Signed in, you can remove anything you published.
          </p>

          {error && <p className={styles.error}>{error}</p>}

          <ul className={styles.rows}>
            {found.map((b) => (
              <li key={`${b.origin}:${b.id}`} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>
                    {b.name}
                    <span className={styles.rowTag}>
                      {b.origin === 'server' ? 'published' : 'built in'}
                    </span>
                  </span>
                  {b.note && <span className={styles.rowSub}>{b.note}</span>}
                  <span className={styles.rowSub}>
                    {b.by}{b.added ? ` · ${b.added}` : ''}
                    {b.tags.length ? ` · ${b.tags.join(' · ')}` : ''}
                  </span>
                </div>
                <div className={styles.rowBtns}>
                  <button type="button" className={styles.miniBtn} onClick={() => onApplyBench(b)}>
                    Load
                  </button>
                  <button
                    type="button"
                    className={styles.miniBtn}
                    onClick={() => {
                      navigator.clipboard?.writeText(onBenchLink(b));
                      setStatus(`Link to “${b.name}” copied.`);
                    }}
                  >
                    Copy link
                  </button>
                  {b.origin === 'server' && (
                    <button
                      type="button"
                      className={`${styles.miniBtn} ${styles.miniDanger}`}
                      onClick={async () => {
                        const res = await onDeleteBench(b.id);
                        if (res.ok) setStatus(`Removed “${b.name}”.`);
                        else setError(res.error);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            ))}
            {!found.length && (
              <li className={styles.empty}>
                {find
                  ? `Nothing matches “${find}”.`
                  : 'Nothing published yet. Build a link, name it, press Publish.'}
              </li>
            )}
          </ul>

          {/* The permanent tier. A server bench is anyone's and can be removed;
              the ones worth keeping belong in the repo, where they are reviewed
              and versioned. */}
          <div className={styles.ioBox}>
            <p className={styles.libNote}>
              Worth keeping for good? Print the entry for the bench on screen and open a pull
              request adding it to <code>src/data/benches.js</code>. Those cannot be deleted by
              anyone and ship with the site even when the server is down.
            </p>
            <button type="button" className={styles.miniBtn} onClick={() => setPub(onPreparePublish())}>
              Print entry for a pull request
            </button>
            {pub && <textarea className={styles.input} rows={14} readOnly value={pub} />}
          </div>
        </>
      )}

      <div className={styles.libFoot}>
        <span className={styles.libNote}>
          {lib.loading && 'Loading the shared library…'}
          {!lib.loading && lib.ok && (
            <>
              Saved to the server and shared with everyone who opens the studio
              {lib.you ? `, signed in as ${lib.you}` : ', signed out, so saves are anonymous'}.
              Built-in parts ship with the site.
            </>
          )}
          {!lib.loading && !lib.ok && (
            <>
              The library server is {lib.reason}
              {lib.cached
                ? ', so this is the last copy this browser saw. Saving is off until it is back.'
                : ', so this is the built-in parts only. Saving is off until it is back.'}
            </>
          )}
        </span>
      </div>

      {/* Anyone who saved gear before the library moved to the server still has
          it in this browser. One button, once, and then it stops asking. */}
      {legacy && lib.ok && (
        <div className={styles.ioBox}>
          <p className={styles.libNote}>
            This browser still has {legacy.antennas.length} antenna(s), {legacy.radios.length}{' '}
            radio(s) and {legacy.benches.length} saved setup(s) from before the library was shared.
            Upload them and everyone gets them.
          </p>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onMigrate();
              setBusy(false);
              setStatus('Uploaded your old gear.');
            }}
          >
            {busy ? 'Uploading…' : 'Upload my old gear'}
          </button>
        </div>
      )}
    </Overlay>
  );
}
