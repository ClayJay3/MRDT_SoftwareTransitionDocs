// Data backing the interactive RoveComm packet builder/decoder.
// The data-type table mirrors the one on the RoveComm page exactly. The packet
// presets are ILLUSTRATIVE convenience examples, not a manifest mirror, the
// manifest in RoveComm_Base is always the source of truth (see the #1 RoveComm
// rule). They exist only to give the builder something to load.

export const RC_VERSION = 3;

// Wire data types, value enum + size, and how to (de)serialize each one with a
// DataView. kind drives the encode/decode path in the component.
export const DATA_TYPES = [
  {name: 'INT8_T',   value: 0, bytes: 1, kind: 'int',   signed: true},
  {name: 'UINT8_T',  value: 1, bytes: 1, kind: 'int',   signed: false},
  {name: 'INT16_T',  value: 2, bytes: 2, kind: 'int',   signed: true},
  {name: 'UINT16_T', value: 3, bytes: 2, kind: 'int',   signed: false},
  {name: 'INT32_T',  value: 4, bytes: 4, kind: 'int',   signed: true},
  {name: 'UINT32_T', value: 5, bytes: 4, kind: 'int',   signed: false},
  {name: 'FLOAT_T',  value: 6, bytes: 4, kind: 'float'},
  {name: 'DOUBLE_T', value: 7, bytes: 8, kind: 'float'},
  {name: 'CHAR',     value: 8, bytes: 1, kind: 'char'},
];

export const typeByName = (name) => DATA_TYPES.find((t) => t.name === name);
export const typeByValue = (v) => DATA_TYPES.find((t) => t.value === v);

// Reserved system packet IDs (from the RoveComm page).
export const SYSTEM_IDS = {
  1: 'PING', 2: 'PING_REPLY', 3: 'SUBSCRIBE', 4: 'UNSUBSCRIBE',
  5: 'INVALID_VERSION', 6: 'NO_DATA',
};

// Illustrative presets so the builder has something to load. Values are made up
// for demonstration, treat the manifest as authoritative for real dataIds/types.
export const PRESETS = [
  {
    label: 'StartAutonomy (11000)', dataId: 11000, type: 'UINT8_T',
    values: '1', note: 'Operator → Autonomy: begin the queued mission.',
  },
  {
    label: 'DriveLeftRight (3000)', dataId: 3000, type: 'INT16_T',
    values: '250, 250', note: 'Autonomy → Core: left & right drive power.',
  },
  {
    label: 'CompassData (6102)', dataId: 6102, type: 'FLOAT_T',
    values: '274.5', note: 'Nav board → everyone: EKF-fused heading, 0–360°.',
  },
  {
    label: 'GPSLatLonAlt (6100)', dataId: 6100, type: 'DOUBLE_T',
    values: '38.406, -110.792, 1380.0', note: 'Nav board telemetry: lat, lon, alt (first 3 elements).',
  },
  {
    label: 'CurrentState (11100)', dataId: 11100, type: 'UINT8_T',
    values: '2', note: 'Autonomy → Basestation: current state-machine state.',
  },
  {
    label: 'PING (1)', dataId: 1, type: 'UINT8_T',
    values: '', note: 'System packet. No payload, count 0.',
  },
];
