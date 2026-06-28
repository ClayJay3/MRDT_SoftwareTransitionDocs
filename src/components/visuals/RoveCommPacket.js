import React, {useMemo, useState} from 'react';
import {
  RC_VERSION, DATA_TYPES, typeByName, typeByValue, SYSTEM_IDS, PRESETS,
} from '@site/src/data/rovecomm';
import styles from './RoveCommPacket.module.css';

// Two-way RoveComm packet tool. BUILD: pick a Data ID + type + values and watch
// the exact wire bytes appear, color-coded back to the 6-byte-header diagram.
// DECODE: paste hex off the wire and get the fields back. All encoding uses a
// big-endian DataView so it matches htons/htonl/htonll on the real boards.
// SSR-safe: no window access, pure computation.

const FIELD_COLORS = {
  Version: '#e06c75',
  'Data ID': '#61afef',
  'Data Count': '#98c379',
  'Data Type': '#e5c07b',
  Payload: '#c678dd',
};

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// --- encoding -------------------------------------------------------------
function writeElement(view, off, type, raw) {
  if (type.kind === 'float') {
    const v = parseFloat(raw);
    if (type.bytes === 4) view.setFloat32(off, v, false);
    else view.setFloat64(off, v, false);
    return Number.isNaN(v);
  }
  if (type.kind === 'char') {
    view.setUint8(off, raw.charCodeAt(0) & 0xff);
    return false;
  }
  const v = Math.trunc(Number(raw));
  const bad = Number.isNaN(v);
  if (type.bytes === 1) type.signed ? view.setInt8(off, v) : view.setUint8(off, v);
  else if (type.bytes === 2) type.signed ? view.setInt16(off, v, false) : view.setUint16(off, v, false);
  else type.signed ? view.setInt32(off, v, false) : view.setUint32(off, v, false);
  return bad;
}

// Build the byte array + per-byte field map from form inputs.
function buildPacket(dataId, typeName, valuesStr) {
  const type = typeByName(typeName);
  const elems = type.kind === 'char'
    ? [...valuesStr]                                   // each char is one element
    : valuesStr.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const count = elems.length;
  const total = 6 + count * type.bytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);

  view.setUint8(0, RC_VERSION);
  view.setUint16(1, dataId & 0xffff, false);
  view.setUint16(3, count & 0xffff, false);
  view.setUint8(5, type.value);

  let anyBad = false;
  elems.forEach((raw, i) => {
    if (writeElement(view, 6 + i * type.bytes, type, raw)) anyBad = true;
  });

  // Per-byte descriptors for the colored grid.
  const cells = [];
  for (let i = 0; i < total; i++) {
    let field = 'Payload';
    if (i === 0) field = 'Version';
    else if (i <= 2) field = 'Data ID';
    else if (i <= 4) field = 'Data Count';
    else if (i === 5) field = 'Data Type';
    const elemStart = i >= 6 && (i - 6) % type.bytes === 0 && count > 0;
    cells.push({hex: hex(view.getUint8(i)), field, elemStart});
  }
  return {cells, count, total, type, anyBad, valid: count > 0 || true};
}

// --- decoding -------------------------------------------------------------
function parseHex(str) {
  const cleaned = str.replace(/0x/gi, ' ').replace(/[,:]/g, ' ');
  const tokens = cleaned.trim().split(/\s+/).filter(Boolean);
  // Allow either space-separated bytes or one long hex blob.
  let bytes;
  if (tokens.length === 1 && tokens[0].length > 2) {
    const blob = tokens[0];
    bytes = blob.match(/.{1,2}/g) || [];
  } else {
    bytes = tokens;
  }
  return bytes.map((t) => parseInt(t, 16));
}

function decodePacket(bytes) {
  if (bytes.some((b) => Number.isNaN(b))) return {error: 'Not valid hex. Use bytes like "03 2A FF" or a blob like 032AFF."'};
  if (bytes.length < 6) return {error: `Header needs 6 bytes, got ${bytes.length}.`};
  const buf = new Uint8Array(bytes).buffer;
  const view = new DataView(buf);
  const version = view.getUint8(0);
  const dataId = view.getUint16(1, false);
  const count = view.getUint16(3, false);
  const typeVal = view.getUint8(5);
  const type = typeByValue(typeVal);

  const warnings = [];
  if (version !== RC_VERSION) warnings.push(`Version is ${version}, not ${RC_VERSION} → a real board would reply INVALID_VERSION.`);
  if (!type) warnings.push(`Data Type ${typeVal} is not a known RoveComm type.`);

  let values = [];
  if (type) {
    const need = 6 + count * type.bytes;
    if (bytes.length < need) {
      warnings.push(`Payload says ${count} × ${type.name} = ${count * type.bytes} bytes, but only ${bytes.length - 6} payload bytes are present.`);
    }
    for (let i = 0; i < count; i++) {
      const off = 6 + i * type.bytes;
      if (off + type.bytes > bytes.length) break;
      if (type.kind === 'char') values.push(JSON.stringify(String.fromCharCode(view.getUint8(off))));
      else if (type.kind === 'float') values.push(type.bytes === 4 ? view.getFloat32(off, false) : view.getFloat64(off, false));
      else if (type.bytes === 1) values.push(type.signed ? view.getInt8(off) : view.getUint8(off));
      else if (type.bytes === 2) values.push(type.signed ? view.getInt16(off, false) : view.getUint16(off, false));
      else values.push(type.signed ? view.getInt32(off, false) : view.getUint32(off, false));
    }
  }
  return {version, dataId, count, type, typeVal, values, warnings};
}

// --- shared byte grid -----------------------------------------------------
function ByteGrid({cells}) {
  return (
    <div className={styles.byteGrid}>
      {cells.map((c, i) => (
        <div
          key={i}
          className={`${styles.byte} ${c.elemStart ? styles.elemStart : ''}`}
          style={{
            background: `${FIELD_COLORS[c.field]}22`,
            borderColor: FIELD_COLORS[c.field],
          }}
          title={`byte ${i} · ${c.field}`}
        >
          <span className={styles.byteHex}>{c.hex}</span>
          <span className={styles.byteIdx}>{i}</span>
        </div>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className={styles.legendRow}>
      {Object.entries(FIELD_COLORS).map(([name, col]) => (
        <span key={name} className={styles.legendItem}>
          <span className={styles.swatch} style={{background: `${col}33`, borderColor: col}} />
          {name}
        </span>
      ))}
    </div>
  );
}

// --- build mode -----------------------------------------------------------
function Builder() {
  const [dataId, setDataId] = useState(11000);
  const [typeName, setTypeName] = useState('UINT8_T');
  const [values, setValues] = useState('1');

  const loadPreset = (p) => {
    if (!p) return;
    setDataId(p.dataId);
    setTypeName(p.type);
    setValues(p.values);
  };

  const result = useMemo(
    () => buildPacket(Number(dataId) || 0, typeName, values),
    [dataId, typeName, values],
  );
  const sys = SYSTEM_IDS[Number(dataId)];

  return (
    <div>
      <div className={styles.controls}>
        <label className={styles.ctrl}>
          <span>Preset</span>
          <select onChange={(e) => loadPreset(PRESETS[e.target.value])} defaultValue="">
            <option value="" disabled>load an example…</option>
            {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          </select>
        </label>
        <label className={styles.ctrl}>
          <span>Data ID</span>
          <input type="number" value={dataId} onChange={(e) => setDataId(e.target.value)} />
        </label>
        <label className={styles.ctrl}>
          <span>Data Type</span>
          <select value={typeName} onChange={(e) => setTypeName(e.target.value)}>
            {DATA_TYPES.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.bytes} B)</option>)}
          </select>
        </label>
        <label className={`${styles.ctrl} ${styles.ctrlWide}`}>
          <span>{typeByName(typeName).kind === 'char' ? 'Text (each char = 1 element)' : 'Values (comma-separated elements)'}</span>
          <input value={values} onChange={(e) => setValues(e.target.value)} placeholder="e.g. 250, -250" />
        </label>
      </div>

      <div className={styles.summary}>
        <code>v{RC_VERSION}</code> · Data ID <code>{Number(dataId) || 0}</code>
        {sys && <span className={styles.sysTag}>{sys}</span>}
        · count <code>{result.count}</code> {result.count === 1 ? 'element' : 'elements'}
        · type <code>{result.type.name}</code>
        · <strong>{result.total} bytes</strong> on the wire
        {result.anyBad && <span className={styles.warn}> ⚠ some values aren’t numbers</span>}
      </div>

      <ByteGrid cells={result.cells} />
      <Legend />
      <p className={styles.note}>
        Count is the number of <em>elements</em>, not bytes. Everything past byte 5 is the
        payload, big-endian, exactly what <code>htons/htonl/htonll</code> would put on the wire.
      </p>
    </div>
  );
}

// --- decode mode ----------------------------------------------------------
function Decoder() {
  const [raw, setRaw] = useState('03 2A F8 00 02 02 00 FA FF 06');
  const bytes = useMemo(() => parseHex(raw), [raw]);
  const decoded = useMemo(() => decodePacket(bytes), [bytes]);

  const cells = useMemo(() => {
    if (decoded.error) return [];
    return bytes.map((b, i) => {
      let field = 'Payload';
      if (i === 0) field = 'Version';
      else if (i <= 2) field = 'Data ID';
      else if (i <= 4) field = 'Data Count';
      else if (i === 5) field = 'Data Type';
      const elemStart = decoded.type && i >= 6 && (i - 6) % decoded.type.bytes === 0;
      return {hex: hex(b & 0xff), field, elemStart};
    });
  }, [bytes, decoded]);

  const sys = !decoded.error && SYSTEM_IDS[decoded.dataId];

  return (
    <div>
      <label className={`${styles.ctrl} ${styles.ctrlFull}`}>
        <span>Paste raw bytes (hex)</span>
        <input value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="03 2A F8 00 02 02 …" />
      </label>

      {decoded.error ? (
        <div className={styles.errorBox}>{decoded.error}</div>
      ) : (
        <>
          <ByteGrid cells={cells} />
          <Legend />
          <table className={styles.kv}>
            <tbody>
              <tr><td>Version</td><td><code>{decoded.version}</code></td></tr>
              <tr><td>Data ID</td><td><code>{decoded.dataId}</code> {sys && <span className={styles.sysTag}>{sys}</span>}</td></tr>
              <tr><td>Data Count</td><td><code>{decoded.count}</code> element{decoded.count === 1 ? '' : 's'}</td></tr>
              <tr><td>Data Type</td><td>{decoded.type ? <code>{decoded.type.name}</code> : <em>unknown ({decoded.typeVal})</em>}</td></tr>
              <tr><td>Payload</td><td>{decoded.values.length ? decoded.values.map((v, i) => <code key={i} className={styles.val}>{String(v)}</code>) : <em>empty</em>}</td></tr>
            </tbody>
          </table>
          {decoded.warnings.map((w, i) => <div key={i} className={styles.warnBox}>⚠ {w}</div>)}
        </>
      )}
    </div>
  );
}

export default function RoveCommPacket() {
  const [mode, setMode] = useState('build');
  return (
    <div className={styles.root}>
      <div className={styles.tabs}>
        <button className={mode === 'build' ? styles.tabSel : styles.tab} onClick={() => setMode('build')}>Build a packet</button>
        <button className={mode === 'decode' ? styles.tabSel : styles.tab} onClick={() => setMode('decode')}>Decode bytes</button>
      </div>
      {mode === 'build' ? <Builder /> : <Decoder />}
      <p className={styles.disclaimer}>
        Presets are illustrative; the <code>manifest.json</code> in RoveComm_Base is the real source of truth for Data IDs and types.
      </p>
    </div>
  );
}
