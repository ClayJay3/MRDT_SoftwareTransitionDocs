// The public bench catalogue: named link setups that ship with the site.
//
// TWO TIERS, ON PURPOSE
//
// Most benches do not belong in this file. Saving one from the studio stores it
// on the gear service, where anyone signed in can add, find and load it without
// touching the repo. That is the everyday path.
//
// This file is the permanent tier. A bench here ships with the site, so it works
// when the service is down, it cannot be removed by anyone using the page, and
// it was reviewed by someone before it landed. Put a bench here when it is one
// the docs argue from and should still be true next year.
//
// To promote one: open the studio's Benches tab, press "Print entry for a pull
// request", paste the result into the list below and open a PR. The test harness
// checks every entry loads and solves, so a broken one cannot reach main.
//
// KEEP THEM SMALL. `slots` names the gear by id and `params` carries only what
// differs from the studio's own defaults. An entry that repeats the defaults
// back is noise in the diff and hides what the bench is actually saying.

export const PUBLISHED_BENCHES = [
  {
    id: 'bom-5ghz-1km',
    name: 'The BOM build, 5.8 GHz at 1 km',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['bom', '5.8', 'mdrs', 'baseline'],
    note: 'What the signals page argues for, on the ground it was argued about. Start here and break one thing at a time.',
    slots: {
      baseRadio: 'netmetal-ax',
      roverRadio: 'netmetal-ax',
      baseAnt: 'signalplus-panel',
      roverAnt: 'mikrotik-hgo',
    },
    params: {site: 'mdrs', band: '5.8', width: 20, distance: 1000},
  },
  {
    id: 'bom-xpol-rover',
    name: 'The BOM build with a cross-polarised rover element',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['bom', '5.8', 'mimo', 'streams'],
    note: 'The one change that gets the second spatial stream back. Compare it against the BOM build and read the streams row.',
    slots: {
      baseRadio: 'netmetal-ax',
      roverRadio: 'netmetal-ax',
      baseAnt: 'signalplus-panel',
      roverAnt: 'rover-xpol-omni',
    },
    params: {site: 'mdrs', band: '5.8', width: 20, distance: 1000},
  },
  {
    id: 'keep-the-rockets',
    name: 'What if we kept the Rockets',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['rocket', '2.4', 'today', 'comparison'],
    note: 'The 2.4 GHz link exactly as it runs today. The Fast Ethernet port is the thing to look at, not the RF.',
    slots: {
      baseRadio: 'rocket-m2',
      roverRadio: 'rocket-m2',
      baseAnt: 'signalplus-panel',
      roverAnt: 'mikrotik-hgo',
    },
    params: {site: 'mdrs', band: '2.4', width: 20, distance: 1000},
  },
  {
    id: 'cheap-alfa-pair',
    name: 'The cheap wide-beam build',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['budget', '5.8', 'coverage'],
    note: 'ALFA panels instead of the SignalPlus. Six dB down and hundreds of metres wider. Turn Coverage on to see what that trade actually buys.',
    slots: {
      baseRadio: 'netmetal-ax',
      roverRadio: 'netmetal-ax',
      baseAnt: 'alfa-apa-m25',
      roverAnt: 'mikrotik-hgo',
    },
    params: {site: 'mdrs', band: '5.8', width: 20, distance: 1000},
  },
  {
    id: 'expensive-lcom',
    name: 'The $790 sector',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['budget', '5.8', 'comparison'],
    note: 'Carrier-grade money on the base antenna. Check the cost per dB, then check whether the link margin moved at all.',
    slots: {
      baseRadio: 'netmetal-ax',
      roverRadio: 'netmetal-ax',
      baseAnt: 'lcom-hg2458-15dp',
      roverAnt: 'mikrotik-hgo',
    },
    params: {site: 'mdrs', band: '5.8', width: 20, distance: 1000},
  },
  {
    id: 'm900-into-the-mesa',
    name: '900 MHz into the Tucumcari mesa',
    by: 'MRDT software',
    added: '2026-08-13',
    tags: ['900', 'tucumcari', 'diffraction', 'rules'],
    note: 'The lifeline link aimed straight into the rising ground, at the 8 MHz channel rule 3.b.v allows. Swing the aim west and the same tripod has a clear path, which is the whole point.',
    slots: {
      baseRadio: 'rocket-m900',
      roverRadio: 'rocket-m900',
      baseAnt: 'yagi-900-13',
      roverAnt: 'rover-whip-900',
    },
    params: {
      site: 'tucumcari', band: '0.9', width: 8, distance: 1500,
      baseE: 0, baseN: -1400, aim: 140, heading: 140,
    },
  },
  {
    id: 'coax-mistake',
    name: 'The 25 m coax mistake',
    by: 'MRDT software',
    added: '2026-08-12',
    tags: ['mistake', '5.8', 'cabling'],
    note: 'Runs the long cable as coax instead of Ethernet. It still passes traffic at 1 km, which is exactly why it ships.',
    slots: {
      baseRadio: 'netmetal-ax',
      roverRadio: 'netmetal-ax',
      baseAnt: 'signalplus-panel',
      roverAnt: 'mikrotik-hgo',
    },
    params: {site: 'mdrs', band: '5.8', width: 20, distance: 1000, baseCable: 18},
  },
];

// ------------------------------------------------------------------ helpers

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

// Entries arrive from a hand-edited file, so treat them the way the gear
// normalizers treat imported JSON: fill what is missing, drop what is the wrong
// shape, and never hand the studio something it cannot render.
export function normalizeBench(b) {
  return {
    id: str(b?.id, 'unnamed'),
    name: str(b?.name, 'Unnamed bench').slice(0, 80),
    by: str(b?.by, 'unattributed').slice(0, 60),
    added: str(b?.added),
    tags: Array.isArray(b?.tags) ? b.tags.filter((t) => typeof t === 'string').slice(0, 8) : [],
    note: str(b?.note).slice(0, 300),
    slots: b?.slots && typeof b.slots === 'object' ? {...b.slots} : {},
    params: b?.params && typeof b.params === 'object' ? {...b.params} : {},
  };
}

export const BENCHES = PUBLISHED_BENCHES.map(normalizeBench);

// What a bench matches on. Everything a person might reasonably type: the name,
// the note, the tags, who published it, and the ids of the gear it uses, so
// searching "rocket" or "yagi" finds the benches built around them without
// anyone having to remember to tag for it.
export const benchHaystack = (b) =>
  [b.name, b.note, b.by, b.id, ...b.tags, ...Object.values(b.slots)]
    .join(' ')
    .toLowerCase();

// Every term has to match somewhere, so extra words narrow rather than widen.
export function searchBenches(list, query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return list;
  return list.filter((b) => {
    const hay = benchHaystack(b);
    return terms.every((t) => hay.includes(t));
  });
}

// The entry a contributor pastes into the list above. Printed rather than
// posted, because the site is static and the review is the point: a bench in
// the catalogue is one someone agreed to put their name on.
export function benchSource(entry) {
  const q = (s) => JSON.stringify(s);
  const tags = entry.tags.length ? entry.tags.map(q).join(', ') : '';
  const pairs = Object.entries(entry.params)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? q(v) : v}`)
    .join(', ');
  return [
    '  {',
    `    id: ${q(entry.id)},`,
    `    name: ${q(entry.name)},`,
    `    by: ${q(entry.by)},`,
    `    added: ${q(entry.added)},`,
    `    tags: [${tags}],`,
    `    note: ${q(entry.note)},`,
    '    slots: {',
    `      baseRadio: ${q(entry.slots.baseRadio)},`,
    `      roverRadio: ${q(entry.slots.roverRadio)},`,
    `      baseAnt: ${q(entry.slots.baseAnt)},`,
    `      roverAnt: ${q(entry.slots.roverAnt)},`,
    '    },',
    `    params: {${pairs}},`,
    '  },',
  ].join('\n');
}
