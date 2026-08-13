// The gear library behind the Signal Studio page: what an antenna and a radio
// are as far as this site is concerned, a catalogue of the parts the signals
// page argues about, and the browser-side storage that lets you type in your
// own and get them back next time.
//
// No React and no physics. The physics lives in signalModel.js and reads the
// radio specs produced here. The library itself lives on the gear service, see
// gearApi.js; what is left in this file is the shapes, the normalizers and a
// one-time read of the browser-local store that came before it. Kept pure and
// synchronous so the studio component stays SSR safe.

import {
  BANDS,
  PHY_FAMILIES,
  REF_MHZ,
  WIDTHS,
  clamp,
  linkLimits,
  omniVBeam,
} from './signalModel';

// ------------------------------------------------------------- antennas
//
// An antenna is a gain, the two beamwidths that gain has to be consistent with,
// and the band those three numbers were measured on. `feed` is the jumper it
// ships with or the one you would actually run to it, because that loss is part
// of choosing the part.
//
// `chains` and `pol` are what turn a 2x2 radio into a 2x2 link, and they are the
// two specs a listing is most likely to leave you to infer. `chains` is how many
// RF ports the part has. One connector is one chain, however many streams the
// radio behind it has. `pol` is what those ports are: 'x' means the two ports
// are cross-polarised (dual-slant, ±45°, or V+H) and see different channels; 'v'
// means everything on this part is vertically polarised, so a second port is a
// second copy of the same channel and the second stream does not survive a clean
// line of sight. Two vertical omnis on a rover mast are 'v', not 'x'.
//
// A sector has two real beamwidths. An omni has one dimension of aperture, so
// its elevation beamwidth follows from its gain and there is nothing to type:
// 41253 / (gain x 360). A yagi has two beamwidths like a sector and differs
// only in how it behaves off its own band. See BEAM_STRETCH.
//
// `ref` matters as soon as a part is not a 5.8 GHz part. A 900 MHz yagi quoted
// as though it were 5.8 GHz gear would be scaled down twice over and model a
// link far worse than the one you would actually build.

export const ANTENNA_KINDS = ['sector', 'yagi', 'omni'];
export const POLARIZATIONS = ['x', 'v'];

export const BUILTIN_ANTENNAS = [
  {
    id: 'signalplus-panel',
    name: 'SignalPlus 2×2 dual-band panel',
    kind: 'sector',
    gain: 18,
    hBeam: 20,
    vBeam: 20,
    feed: 0.4,
    chains: 2,
    pol: 'x',
    price: 80,
    qty: 1,
    note: '~$80 marketplace listing, 2× N-female, never tested on a range. The build in the BOM.',
  },
  {
    id: 'radiolabs-mimodir',
    name: 'RadioLabs MiMoDIR245812',
    kind: 'sector',
    gain: 12,
    hBeam: 35,
    vBeam: 35,
    feed: 0.4,
    chains: 2,
    pol: 'x',
    price: 130,
    qty: 1,
    note: 'Claims less than its beamwidth allows, which is the safe direction to be wrong in.',
  },
  {
    id: 'alfa-apa-m25',
    name: 'ALFA APA-M25 pair',
    kind: 'sector',
    gain: 10,
    hBeam: 66,
    vBeam: 16,
    feed: 0.4,
    // Two separate panels, so you are free to mount one of them on its side.
    // If you do not, the pair is two copies of one channel.
    chains: 2,
    pol: 'x',
    price: 45,
    qty: 2,
    note: 'The cheap wide-beam option. ±649 m of lateral coverage at 1 km. Two panels, so mount the second one rotated 90° or the pair is single-polarised.',
  },
  {
    id: 'lcom-hg2458-15dp',
    name: 'L-com HG2458-15DP-090',
    kind: 'sector',
    gain: 15,
    hBeam: 90,
    vBeam: 7,
    feed: 0.4,
    chains: 2,
    pol: 'x',
    price: 790,
    qty: 1,
    note: '$790 carrier-grade sector, dual-slant. A 7° elevation beam is what makes downtilt dangerous.',
  },
  {
    id: 'fake-spec-panel',
    name: 'Marketplace panel, 24 dBi "claimed"',
    kind: 'sector',
    gain: 24,
    hBeam: 90,
    vBeam: 20,
    feed: 0.4,
    chains: 2,
    pol: 'x',
    price: 35,
    qty: 1,
    note: 'The spec sheet that does not survive D ≈ 41253 / (H × V). Derated on sight.',
  },
  {
    id: 'yagi-900-13',
    name: '900 MHz yagi, 13 dBi',
    kind: 'yagi',
    ref: '0.9',
    gain: 13,
    hBeam: 44,
    vBeam: 47,
    feed: 0.5,
    // A yagi is one boom, one feed, one polarization. Two streams need two of
    // them, crossed, which is a different part, not a second connector.
    chains: 1,
    pol: 'v',
    price: 60,
    qty: 1,
    note: 'A metre of boom for 13 dBi, single port. 900 MHz gets through brush that stops 5.8 dead, and Part 15 caps it at 36 dBm EIRP anyway, so the gain buys reach, not power.',
  },
  {
    id: 'yagi-2400-15',
    name: '2.4 GHz yagi, 15 dBi',
    kind: 'yagi',
    ref: '2.4',
    gain: 15,
    hBeam: 32,
    vBeam: 36,
    feed: 0.4,
    chains: 1,
    pol: 'v',
    price: 40,
    qty: 1,
    note: 'End-fire rather than aperture: it gives up 10log₁₀ off its own band where a panel gives up 20. One port, so one stream.',
  },
  {
    id: 'mikrotik-hgo',
    name: 'MikroTik HGO-antenna-OUT ×2',
    kind: 'omni',
    gain: 6.7,
    feed: 0.3,
    // The BOM buys two of these, one per RP-SMA port. That is two chains, and
    // both of them vertical, which is the point the page has to make.
    chains: 2,
    pol: 'v',
    price: 15,
    qty: 2,
    note: 'The rover element in the BOM: 6.7 dBi at 5 GHz, 3.6 at 2.4, screws straight on. Two of them is two chains of the SAME polarization, so the link still runs one stream.',
  },
  {
    id: 'rover-xpol-omni',
    name: 'Dual-slant rover omni, 5 dBi',
    kind: 'omni',
    gain: 5,
    feed: 0.3,
    chains: 2,
    pol: 'x',
    price: 45,
    qty: 1,
    note: 'What a 2×2 rover actually needs: two polarizations in one radome. Costs 1.7 dB against the HGO pair and buys back the second spatial stream.',
  },
  {
    id: 'rover-whip-900',
    name: '900 MHz rover whip, 3 dBi',
    kind: 'omni',
    ref: '0.9',
    gain: 3,
    feed: 0.3,
    chains: 1,
    pol: 'v',
    price: 12,
    qty: 1,
    note: 'A half-wave at 915 MHz is 16 cm, so this is the one 900 MHz element that fits on a rover without becoming a mast.',
  },
  {
    id: 'rover-whip-3',
    name: 'Low-gain rover whip, 3 dBi',
    kind: 'omni',
    gain: 3,
    feed: 0.3,
    chains: 1,
    pol: 'v',
    price: 10,
    qty: 2,
    note: 'A 57° tall toroid. Only 1.7 dB down at 22° of vehicle pitch.',
  },
  {
    id: 'rover-omni-9',
    name: 'High-gain rover omni, 9 dBi',
    kind: 'omni',
    gain: 9,
    feed: 0.3,
    chains: 1,
    pol: 'v',
    price: 18,
    qty: 2,
    note: 'The tempting mistake: 14° tall, so 22° of pitch puts the base station 20 dB down.',
  },
];

// ---------------------------------------------------------------- radios

// `eth` is the wired port behind the radio, in Mbps. It belongs here because on
// the M-series it is the binding constraint long before the air is, and a link
// budget that leaves it out will happily promise 150 Mbps through a 100 Mbps
// port. Numbers are off the manufacturers' own specification pages.
export const BUILTIN_RADIOS = [
  {
    id: 'netmetal-ax',
    name: 'MikroTik NetMetal ax',
    family: 'ax',
    streams: 2,
    backoffTop: 8,
    eth: 1000,
    bands: {
      '2.4': {txMax: 29, widths: [10, 20, 40], sens0: -97, sensTop: -67},
      '5.8': {txMax: 28, widths: [10, 20, 40, 80], sens0: -96, sensTop: -67},
    },
    price: 169,
    note: 'L23UGSR-5HaxD2HaxD-NM, ~$169. Both bands concurrent on the same diplexed pair. Gigabit port plus a 2.5G SFP, so the wire is never the limit.',
  },
  {
    id: 'rocket-m2',
    name: 'Ubiquiti Rocket M2',
    family: 'n',
    streams: 2,
    backoffTop: 4,
    eth: 100,
    bands: {'2.4': {txMax: 28, widths: [5, 8, 10, 20, 40], sens0: -96, sensTop: -75}},
    price: 89,
    note: 'What the rover runs today. 802.11n, 2.4 only, and a 10/100 port behind it.',
  },
  {
    id: 'rocket-m5',
    name: 'Ubiquiti Rocket M5',
    family: 'n',
    streams: 2,
    backoffTop: 4,
    eth: 100,
    bands: {'5.8': {txMax: 27, widths: [5, 8, 10, 20, 40], sens0: -96, sensTop: -75}},
    price: 89,
    note: 'The 5.8 GHz half we shut down. 10/100 BASE-TX, which is the bottleneck that shut it down.',
  },
  {
    id: 'rocket-m900',
    name: 'Ubiquiti Rocket M900',
    family: 'n',
    streams: 2,
    backoffTop: 4,
    eth: 100,
    bands: {'0.9': {txMax: 28, widths: [5, 8, 10, 20], sens0: -96, sensTop: -75}},
    price: 199,
    note: 'The M-series card for 902–928 MHz, 10/100 port. airOS offers 3/5/8/10/20 MHz; URC rule 3.b.v allows 8 and narrower, so 8 is the one to fly.',
  },
  {
    id: 'netmetal-ac2',
    name: 'MikroTik NetMetal ac² (discontinued)',
    family: 'ac',
    streams: 2,
    backoffTop: 6,
    eth: 1000,
    bands: {
      '2.4': {txMax: 29, widths: [10, 20, 40], sens0: -97, sensTop: -71},
      '5.8': {txMax: 27, widths: [10, 20, 40, 80], sens0: -96, sensTop: -70},
    },
    price: 149,
    note: 'End of life. Here to show what the previous generation actually costs you. It is also on the older wireless package, so it will not station-bridge to an ax unit.',
  },
];

// -------------------------------------------------------------- helpers

export const BAND_IDS = Object.keys(BANDS);
export const ALL_WIDTHS = Object.keys(WIDTHS).map(Number).sort((a, b) => a - b);

const num = (v, fallback) => (Number.isFinite(+v) ? +v : fallback);

// An id that will not collide with a built-in and reads well in exported JSON.
export function newId(prefix) {
  const stamp = Date.now().toString(36).slice(-5);
  const salt = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  return `${prefix}-${stamp}${salt}`;
}

// Antennas arrive from three places: this file, the gear service, and the old
// browser-local store during migration. Only the first is trustworthy, so
// everything gets clamped into a range the sliders can actually represent.
export function normalizeAntenna(a) {
  const kind = ANTENNA_KINDS.includes(a?.kind) ? a.kind : 'sector';
  const gain = clamp(num(a?.gain, 12), -3, 30);
  const chains = clamp(Math.round(num(a?.chains, 2)), 1, 4);
  return {
    id: a?.id || newId('ant'),
    name: (a?.name || 'Unnamed antenna').slice(0, 60),
    kind,
    // The band the three numbers below were measured on. Unknown means 5.8,
    // because that is what every part in this catalogue meant before parts
    // could say otherwise.
    ref: BANDS[a?.ref] ? a.ref : '5.8',
    gain,
    hBeam: kind === 'omni' ? 360 : clamp(num(a?.hBeam, 30), 3, 180),
    vBeam: kind === 'omni' ? omniVBeam(gain) : clamp(num(a?.vBeam, 30), 3, 120),
    feed: clamp(num(a?.feed, 0.4), 0, 25),
    // USD, and 0 means "not priced" rather than "free". An unpriced part drops
    // out of the build total instead of quietly making it look cheap.
    price: clamp(num(a?.price, 0), 0, 100000),
    qty: clamp(Math.round(num(a?.qty, 1)), 1, 8),
    chains,
    // A one-port antenna has nothing to cross with, so its polarization is a
    // single one whatever the listing was hoping to imply. Anything else that
    // does not say defaults to cross-polarised, which is what a two-port panel
    // sold for MIMO nearly always is.
    pol: chains < 2 ? 'v' : POLARIZATIONS.includes(a?.pol) ? a.pol : 'x',
    note: (a?.note || '').slice(0, 240),
  };
}

// The band an antenna's numbers came off, in MHz, for the model.
export const antennaRefMHz = (a) => (BANDS[a?.ref] || BANDS['5.8']).fMHz;

export function normalizeRadioSpec(r) {
  const family = PHY_FAMILIES[r?.family] ? r.family : 'ax';
  const bands = {};
  for (const id of BAND_IDS) {
    const b = r?.bands?.[id];
    if (!b) continue;
    const widths = ALL_WIDTHS.filter((w) => (b.widths || [20]).map(Number).includes(w));
    const sens0 = clamp(num(b.sens0, -96), -110, -50);
    bands[id] = {
      txMax: clamp(num(b.txMax, 25), 0, 40),
      widths: widths.length ? widths : [20],
      sens0,
      // A top rung that hears better than the bottom one is not a radio.
      sensTop: clamp(num(b.sensTop, -67), sens0, -40),
    };
  }
  // A radio with no bands cannot be saved; fall back to the band it most
  // likely meant rather than producing something that silently never links.
  if (!Object.keys(bands).length) {
    bands['5.8'] = {txMax: 25, widths: [20], sens0: -96, sensTop: -67};
  }
  return {
    id: r?.id || newId('radio'),
    name: (r?.name || 'Unnamed radio').slice(0, 60),
    family,
    streams: clamp(Math.round(num(r?.streams, 2)), 1, 4),
    backoffTop: clamp(num(r?.backoffTop, 8), 0, 20),
    eth: clamp(num(r?.eth, 1000), 1, 10000),
    price: clamp(num(r?.price, 0), 0, 100000),
    bands,
    note: (r?.note || '').slice(0, 240),
  };
}

// A one-line summary for the pickers and the library list. The band is on the
// front of it because a 13 dBi part means two different things depending on
// where that 13 dBi was measured.
// How many streams this part can carry on a line-of-sight link, and why. One
// port is one stream; two same-polarity ports are two copies of one channel.
export const antennaRank = (a) => (a.chains < 2 ? 1 : a.pol === 'x' ? a.chains : 1);
export const polLabel = (a) =>
  a.chains < 2 ? 'single port' : a.pol === 'x' ? `${a.chains}× cross-pol` : `${a.chains}× same pol`;

export const antennaSummary = (a) => {
  const at = (BANDS[a.ref] || BANDS['5.8']).label;
  const rf = `${polLabel(a)} → ${antennaRank(a)} stream${antennaRank(a) > 1 ? 's' : ''}`;
  return a.kind === 'omni'
    ? `omni · ${a.gain} dBi at ${at} · ${omniVBeam(a.gain).toFixed(0)}° tall · ${rf} · feed ${a.feed} dB`
    : `${a.kind} · ${a.gain} dBi at ${at} · ${a.hBeam}°×${a.vBeam}° · ${rf} · feed ${a.feed} dB`;
};

export const radioSummary = (r) => {
  const bands = BAND_IDS.filter((id) => r.bands[id]).map((id) => BANDS[id].label);
  const label = PHY_FAMILIES[r.family]?.label || r.family;
  const eth = r.eth >= 1000 ? `${r.eth / 1000}G` : `${r.eth}M`;
  return `${label} · ${r.streams}×${r.streams} · ${bands.length ? bands.join(' + ') : 'no band'} · ${eth} port`;
};

// ------------------------------------------------------------------ money
//
// The page's central claim is that gain is the least important thing on a spec
// sheet, and the cleanest way to make that argument is per dollar. One radio
// and one antenna set at each end, priced per unit and multiplied by how many
// that end actually needs, so the rover buys two omnis, not one. The total is
// the whole link, both ends, because that is what you actually write a check
// for.
//
// An unpriced part contributes nothing and is counted, so the total can say it
// is incomplete rather than quietly reading low.
export function buildCost({baseAnt, roverAnt, baseRadio, roverRadio}) {
  const items = [];
  const add = (part, qty, what) => {
    if (!part) return;
    items.push({name: part.name, qty, each: part.price || 0, total: (part.price || 0) * qty, what});
  };
  add(baseRadio, 1, 'base radio');
  add(roverRadio, 1, 'rover radio');
  add(baseAnt, baseAnt?.qty ?? 1, 'base antenna');
  add(roverAnt, roverAnt?.qty ?? 1, 'rover antenna');
  const total = items.reduce((a, b) => a + b.total, 0);
  const unpriced = items.filter((i) => i.each === 0).length;
  return {items, total, unpriced};
}

// ------------------------------------------------------- exporting a profile
//
// The page tells you to cross-check this against SPLAT! or Radio Mobile before
// trusting it at competition, which is only actionable if you can get the
// profile out. Ground, line of sight and the Fresnel envelope, one row per
// sample, in the units every other tool wants.
export function profileCsv(r, p) {
  if (!r.profile) return '';
  const n = r.profile.length - 1;
  const rows = [
    '# MRDT signal studio path profile',
    `# site,${p.site},base_e_m,${p.baseE},base_n_m,${p.baseN},heading_deg,${p.heading}`,
    `# distance_m,${r.D},band_mhz,${(BANDS[p.band] || BANDS['5.8']).fMHz},base_agl_m,${p.baseH},rover_agl_m,${p.roverH}`,
    'distance_m,ground_m,los_m,fresnel1_m,clearance_f1',
  ];
  for (let i = 0; i <= n; i++) {
    const d1 = (i / n) * r.D;
    const d2 = r.D - d1;
    const ground = r.profile[i];
    const los = r.baseZ + ((r.roverZ - r.baseZ) * i) / n;
    const f1 = d1 > 0 && d2 > 0 ? Math.sqrt(((299.792458 / (BANDS[p.band] || BANDS['5.8']).fMHz) * d1 * d2) / r.D) : 0;
    const clear = f1 > 0 ? (los - ground) / f1 : '';
    rows.push(
      [d1.toFixed(1), ground.toFixed(2), los.toFixed(2), f1.toFixed(2),
       clear === '' ? '' : clear.toFixed(3)].join(','),
    );
  }
  return rows.join('\n');
}

// ------------------------------------------------------ applying to a link
//
// Slots are the join between the library and the model's flat parameter bag.

// The sector model tops out at a 180° azimuth beam, so an omni bolted to the
// mast is applied as the widest sector the model can represent rather than
// silently becoming a 360° antenna it cannot describe.
export const BASE_OMNI_HBEAM = 120;

// Clamped to the studio's own slider domains, so what a slider reads is always
// what the model was handed. Everything the editor can produce fits inside
// these bounds; only a hand-edited import file can hit the clamp.
export function applyBaseAntenna(a) {
  const ant = normalizeAntenna(a);
  return {
    baseGain: clamp(ant.gain, 3, 30),
    baseHBeam: clamp(ant.kind === 'omni' ? BASE_OMNI_HBEAM : ant.hBeam, 8, 180),
    baseVBeam: clamp(ant.kind === 'omni' ? omniVBeam(ant.gain) : ant.vBeam, 4, 120),
    baseCable: clamp(ant.feed, 0, 20),
    // Not sliders: what the part is, and where its numbers were measured. Both
    // only matter once the link runs on a band other than that one.
    baseKind: ant.kind,
    baseRefMHz: antennaRefMHz(ant),
    // Nor are these: how many RF paths the mast really has, and whether they
    // are different enough from each other to carry different streams.
    baseChains: ant.chains,
    baseXpol: ant.pol === 'x',
  };
}

// The rover element is modelled as a vertical omni whose toroid follows from
// its gain, so a sector or a yagi dropped in this slot contributes its gain and
// nothing else. The studio says so out loud rather than pretending otherwise.
export function applyRoverAntenna(a) {
  const ant = normalizeAntenna(a);
  return {
    roverGain: clamp(ant.gain, 2, 12),
    roverCable: clamp(ant.feed, 0, 4),
    roverRefMHz: antennaRefMHz(ant),
    roverChains: ant.chains,
    roverXpol: ant.pol === 'x',
  };
}

// True when the live sliders still match the part that was selected. Drift is
// not an error. It is how you design a new part, but the studio has to say
// which of the two you are looking at.
export function baseMatches(p, a) {
  const want = applyBaseAntenna(a);
  return (
    Math.abs(p.baseGain - want.baseGain) < 0.05 &&
    Math.abs(p.baseHBeam - want.baseHBeam) < 0.5 &&
    Math.abs(p.baseVBeam - want.baseVBeam) < 0.5 &&
    Math.abs(p.baseCable - want.baseCable) < 0.05 &&
    // Kind, reference band and the two RF-path specs are not on a slider, so
    // they cannot drift on their own, but they can still be left behind by the
    // last part loaded, and a 900 MHz yagi wearing a panel's scaling is a
    // different antenna.
    (p.baseKind || 'sector') === want.baseKind &&
    (p.baseRefMHz || REF_MHZ) === want.baseRefMHz &&
    (p.baseChains ?? 2) === want.baseChains &&
    (p.baseXpol ?? true) === want.baseXpol
  );
}

export function roverMatches(p, a) {
  const want = applyRoverAntenna(a);
  return (
    Math.abs(p.roverGain - want.roverGain) < 0.05 &&
    Math.abs(p.roverCable - want.roverCable) < 0.05 &&
    (p.roverRefMHz || REF_MHZ) === want.roverRefMHz &&
    (p.roverChains ?? 2) === want.roverChains &&
    (p.roverXpol ?? true) === want.roverXpol
  );
}

// Which band a reference frequency belongs to. The model carries MHz because it
// does arithmetic with it; everything a person reads is a band.
export const bandOfMHz = (mhz) =>
  BAND_IDS.find((id) => BANDS[id].fMHz === (mhz || REF_MHZ)) || '5.8';

// Pull the current sliders back out as a saveable part, which is what makes
// "drag things until it works, then keep it" a workflow rather than a note. The
// kind and the band it is quoted at come along, or editing a 900 MHz yagi and
// saving it would quietly hand back a 5.8 GHz panel.
export const antennaFromBase = (p, name) =>
  normalizeAntenna({
    name,
    kind: p.baseKind === 'yagi' ? 'yagi' : 'sector',
    ref: bandOfMHz(p.baseRefMHz),
    gain: p.baseGain,
    hBeam: p.baseHBeam,
    vBeam: p.baseVBeam,
    feed: p.baseCable,
    chains: p.baseChains ?? 2,
    pol: (p.baseXpol ?? true) ? 'x' : 'v',
  });

export const antennaFromRover = (p, name) =>
  normalizeAntenna({
    name,
    kind: 'omni',
    ref: bandOfMHz(p.roverRefMHz),
    gain: p.roverGain,
    feed: p.roverCable,
    chains: p.roverChains ?? 2,
    pol: (p.roverXpol ?? true) ? 'x' : 'v',
  });

// Swapping a radio can invalidate the band, the channel width and both TX
// power settings at once. An M2 has no 5 GHz to be on and no 80 MHz to tune.
// Drag whatever is now illegal back into range rather than solving a link that
// could not exist. TX power stops at the slider's own floor: a radio that
// cannot reach the band at all is already dead in the model, and burying the
// slider at -100 dBm would just make it un-recoverable when a real radio goes
// back in the slot.
export function reconcileLink(p) {
  const lim = linkLimits(p.baseRadio, p.roverRadio);
  const band = lim.bands.includes(p.band) ? p.band : lim.bands[0] || p.band;
  const widths = lim.widthsFor(band);
  const width = widths.includes(p.width)
    ? p.width
    : widths.reduce((best, w) => (Math.abs(w - p.width) < Math.abs(best - p.width) ? w : best));
  const tx = lim.txMax(band);
  return {
    ...p,
    band,
    width,
    baseTx: clamp(p.baseTx, 5, Math.max(5, tx.base)),
    roverTx: clamp(p.roverTx, 5, Math.max(5, tx.rover)),
  };
}

// ---------------------------------------------------------------- storage
//
// The library lives on the server now, in the gear service, so that everyone on
// the team sees the same antennas, radios and benches. See gearApi.js.
//
// What is left here is the old browser-local store, kept for exactly one
// purpose: anyone who saved gear before the service existed still has it in
// this browser, and it should not simply vanish. The studio offers to upload it
// once and then stops asking.

export const STORE_KEY = 'mrdt.signal-studio.gear.v1';
export const MIGRATED_KEY = 'mrdt.signal-studio.gear.migrated.v1';

// Whatever the old store holds, normalized and with the setups folded in as
// benches. Setups were the private version of a published bench, so they are
// the same thing and migrate straight across.
export function legacyGear() {
  if (typeof window === 'undefined') return null;
  try {
    if (window.localStorage.getItem(MIGRATED_KEY)) return null;
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const antennas = (parsed.antennas || []).map(normalizeAntenna);
    const radios = (parsed.radios || []).map(normalizeRadioSpec);
    const benches = (parsed.setups || [])
      .filter((s) => s && s.name && s.params)
      .map((s) => ({
        name: s.name,
        note: s.summary || '',
        tags: [],
        slots: s.slots || {},
        params: s.params || {},
      }));
    if (!antennas.length && !radios.length && !benches.length) return null;
    return {antennas, radios, benches};
  } catch {
    return null;
  }
}

// Called once the upload has succeeded. The old data is left where it is rather
// than deleted, because a migration that goes wrong should be recoverable by
// hand, and it is a few kilobytes.
export function markMigrated() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
  } catch {
    // Not being able to record it means being asked again, which is survivable.
  }
}

// A part as the service wants it: the shape above plus the name it is saved
// under. The service adds the id, the author and the date.
export const antennaPayload = (a) => ({
  id: a.id && a.id.startsWith('ant-') ? undefined : a.id,
  name: a.name,
  note: a.note,
  kind: a.kind,
  ref: a.ref,
  gain: a.gain,
  hBeam: a.hBeam,
  vBeam: a.vBeam,
  feed: a.feed,
  chains: a.chains,
  pol: a.pol,
  price: a.price,
  qty: a.qty,
});

export const radioPayload = (r) => ({
  id: r.id && r.id.startsWith('radio-') ? undefined : r.id,
  name: r.name,
  note: r.note,
  family: r.family,
  streams: r.streams,
  backoffTop: r.backoffTop,
  eth: r.eth,
  price: r.price,
  bands: r.bands,
});
