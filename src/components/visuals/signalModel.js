// The propagation model behind SignalLab, kept free of React so it can be
// exercised directly by the test harness in scripts/test_signal_model.mjs.
//
// The physics is real: Friis, a coherent two-ray ground reflection with
// Rayleigh roughness, ITU-R P.526 knife-edge diffraction over either a
// synthetic ridge or a baked USGS heightmap, the first Fresnel zone, the FCC
// Part 15 EIRP ceiling, and the NetMetal ax MCS and sensitivity tables straight
// off the datasheet. Rate control rides a log-normal fade, and the two
// directions share one half-duplex channel. Treat the Mbps as teaching values,
// not a throughput prediction.
//
// Pure and synchronous throughout, so the component stays SSR safe.

import {
  GRID,
  SPAN_M,
  diffractionLoss,
  distanceToEdge,
  groundPlane,
  heightGrid,
  jv,
  pathProfile,
  sampleHeight,
  worstClearance,
} from './terrainModel';


// ---------------------------------------------------------------- constants

// Antenna numbers are quoted at some band, and unless a part says otherwise
// that band is 5.8 GHz. Everything else scales off whatever it was quoted at.
export const REF_MHZ = 5800;

// The band itself is physics. Only fMHz belongs to it. txMax and widths are
// the DEFAULT radio's limits on that band, kept here because the doc-page lab
// has no radio picker; anything with one reads them off the radio instead.
//
// 902–928 MHz is 26 MHz of ISM in total, so 40 MHz is not a channel that exists
// there no matter what a radio claims to tune.
export const BANDS = {
  '0.9': {label: '900 MHz', fMHz: 915, txMax: 30, widths: [5, 8, 10, 20]},
  '2.4': {label: '2.4 GHz', fMHz: 2437, txMax: 29, widths: [10, 20, 40]},
  '5.8': {label: '5.8 GHz', fMHz: 5800, txMax: 28, widths: [10, 20, 40, 80]},
};

// URC 2026 rule 3.b.v caps 900 MHz at 8 MHz channels, inside one of three
// sub-bands. That is narrower than any radio on the market will let you tune, so
// the model has to say which widths are legal rather than which are possible.
// A 20 MHz 900 MHz link models fine and cannot be flown.
export const RULE_MAX_WIDTH = {'0.9': 8};

// How an antenna's numbers move when the link runs on a band other than the one
// the part was specified at, as an exponent on the wavelength ratio, per plane.
//
// An aperture (panel, dish, sector) keeps its physical size rather than its
// beamwidth, so both beamwidths scale with wavelength and the gain falls by
// 20log₁₀ of the ratio. A yagi is an end-fire array whose gain follows boom
// length in wavelengths, so it gives up only 10log₁₀, and a beam that must
// still satisfy D ≈ 41253/(H × V) can therefore only broaden by the square root
// of the ratio. A vertical omni is round in azimuth on every band it works on,
// so all of its 10log₁₀ shows up in the elevation plane.
//
// Nothing here is applied to gain directly: the beamwidths carry it, and the
// directivity ceiling below turns them back into the gain that is left.
export const BEAM_STRETCH = {
  sector: {h: 1, v: 1},
  yagi: {h: 0.5, v: 0.5},
  omni: {h: 0, v: 1},
};

// 802.11ax, 20 MHz, 0.8 us guard interval. Per-stream Mbps.
// Sanity check: MCS11 x 2 streams x 2.00 (40 MHz) = 574 Mbps, and x 8.38
// (160 MHz) = 2404 Mbps, which is exactly what MikroTik prints on the datasheet.
export const PHY20 = [8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86.0, 103.2, 114.7, 129.0, 143.4];

// Datasheet receive sensitivity, 5 GHz, 20 MHz, dBm. Anchored on the three
// numbers MikroTik publishes: -96 at MCS0, -70 at MCS9, -67 at MCS11.
export const SENS20 = [-96, -94, -91, -89, -85, -81, -80, -78, -74, -70, -69, -67];

// The radio backs its own power off as the constellation gets denser: the
// NetMetal ax does its full rated power at MCS0 and 8 dB less at MCS11.
export const TX_BACKOFF = [0, 0, 1, 1, 2, 3, 4, 4, 6, 7, 7, 8];

// Rate multiplier, and how far the thermal noise floor moves: 10log10(BW/20).
export const WIDTHS = {
  5: {rate: 0.25, sens: -6.0},
  8: {rate: 0.4, sens: -3.98},
  10: {rate: 0.5, sens: -3.0},
  20: {rate: 1.0, sens: 0.0},
  40: {rate: 2.0, sens: 3.0},
  80: {rate: 4.19, sens: 6.0},
};

export const STREAMS = 2;
export const MAC_EFFICIENCY = 0.55; // 802.11ax goodput as a fraction of PHY rate
export const VIDEO_FLOOR = 8; // Mbps of H.265 the mission actually needs
export const CONTROL_FLOOR = 0.5; // Mbps of joystick and telemetry
export const CONDUCTED_MAX = 30; // dBm, the 1 W Part 15 conducted ceiling

// Slow fading on a moving rover over mixed ground, one standard deviation.
// This is what turns "the link closes" into "the link closes most of the time",
// and it is the reason margin is worth buying.
export const SHADOW_SIGMA = 5;

// Ground reflection. At grazing incidence the bounce flips phase and comes
// back nearly as strong as it left, for either polarization.
export const GROUND_GAMMA = 0.98;
export const SURFACE_ROUGHNESS = 0.1; // metres RMS, rolling desert

// ---------------------------------------------------------------- radios
//
// A radio, as far as this model is concerned, is four things: a rate ladder, a
// receive sensitivity curve, a per-band conducted power ceiling and a list of
// channel widths it will actually tune. Everything else about it is marketing.
//
// The two ends are specified separately, because a link is not symmetric: the
// rung the pair settles on is limited by whichever end is worse. The transmit
// side supplies power and backoff, the receive side supplies sensitivity, and
// the rate ladder is the intersection of both.

// Per-stream Mbps at 20 MHz, and the sensitivity curve that goes with the
// modulation family. 11n and 11ac are quoted at the 0.4 us short guard
// interval, 11ax at 0.8 us, which is how each generation's datasheets print it.
export const PHY_FAMILIES = {
  ax: {
    label: '802.11ax',
    phy: PHY20,
    sens: SENS20,
    backoff: TX_BACKOFF,
  },
  ac: {
    label: '802.11ac',
    phy: [7.2, 14.4, 21.7, 28.9, 43.3, 57.8, 65.0, 72.2, 86.7, 96.3],
    sens: [-96, -94, -91, -89, -85, -81, -80, -78, -74, -70],
    backoff: [0, 0, 1, 1, 2, 3, 4, 4, 6, 7],
  },
  n: {
    label: '802.11n',
    phy: [7.2, 14.4, 21.7, 28.9, 43.3, 57.8, 65.0, 72.2],
    sens: [-96, -94, -91, -89, -85, -81, -80, -78],
    backoff: [0, 0, 1, 1, 2, 3, 4, 4],
  },
};

// The radio this whole page was written around. Its 2.4 GHz curve is one dB
// worse than its 5 GHz curve, which is the sensAdj the older code carried.
export const DEFAULT_RADIO = {
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
};

// What a wired port lets past, as a fraction of its nominal rate. Framing,
// preamble and the interframe gap are about 2% of Ethernet; TCP over it lands
// near 94% of line rate. The number matters because a radio can be fast enough
// on the air and still be a 94 Mbps radio, which is exactly the argument for
// retiring the Rockets, and the model was not making it.
export const ETH_EFFICIENCY = 0.94;

// A band a radio does not have is not a slow link, it is no link. -100 dBm of
// conducted power says that without putting an infinity anywhere downstream.
const DEAD_BAND = {txMax: -100, widths: [20], sens: SENS20};

// Rescale a family's published curve onto two anchor points. A datasheet prints
// the bottom rung and the top rung and nothing in between, so take those two
// and keep the shape of the curve the silicon actually has.
export function sensCurve(family, sens0, sensTop) {
  const ref = (PHY_FAMILIES[family] || PHY_FAMILIES.ax).sens;
  const span = ref[ref.length - 1] - ref[0];
  const k = Math.abs(span) < 1e-9 ? 1 : (sensTop - sens0) / span;
  return ref.map((s) => sens0 + (s - ref[0]) * k);
}

// Fill in whatever a spec left out and pre-compute the two curves, so solve()
// can treat every radio. Built in or typed in by hand. Identically.
export function normalizeRadio(spec) {
  const s = spec || DEFAULT_RADIO;
  const family = PHY_FAMILIES[s.family] ? s.family : 'ax';
  const fam = PHY_FAMILIES[family];
  const streams = clamp(Math.round(s.streams ?? 2), 1, 4);
  // The radio backs its own power off as the constellation gets denser. Radios
  // differ in how hard, so keep the family's shape and scale it to the one
  // number a datasheet lets you read off: the backoff at the top rung.
  const famTop = fam.backoff[fam.backoff.length - 1] || 1;
  const backoffTop = clamp(s.backoffTop ?? famTop, 0, 20);
  const backoff = fam.backoff.map((b) => (b * backoffTop) / famTop);

  const bands = {};
  for (const id of Object.keys(BANDS)) {
    const b = s.bands ? s.bands[id] : DEFAULT_RADIO.bands[id];
    if (!b) continue;
    const widths = Object.keys(WIDTHS)
      .map(Number)
      .filter((w) => (b.widths || [20]).includes(w));
    bands[id] = {
      txMax: clamp(b.txMax ?? 25, -10, 40),
      widths: widths.length ? widths : [20],
      sens0: b.sens0 ?? -96,
      sensTop: b.sensTop ?? -67,
      sens: sensCurve(family, b.sens0 ?? -96, b.sensTop ?? -67),
    };
  }

  return {
    id: s.id || 'custom',
    name: s.name || 'Custom radio',
    family,
    familyLabel: fam.label,
    streams,
    backoffTop,
    // The wired port behind the radio. Unstated means gigabit, which is the
    // only answer that never becomes the bottleneck by accident.
    eth: clamp(s.eth ?? 1000, 1, 10000),
    phy: fam.phy,
    backoff,
    bands,
  };
}

// The band table for one radio, or the dead band if it cannot tune there.
export const radioBand = (radio, bandId) => radio.bands[bandId] || DEAD_BAND;
export const radioHasBand = (radio, bandId) => Boolean(radio.bands[bandId]);

// What the pair can legally do together: only the bands both ends have, only
// the widths both ends tune, and only as many spatial streams as the weaker
// end. Used by the UI to build its pills, so an impossible link cannot be
// dialled in by accident.
export function linkLimits(baseSpec, roverSpec) {
  const base = normalizeRadio(baseSpec);
  const rover = normalizeRadio(roverSpec);
  const bands = Object.keys(BANDS).filter((id) => radioHasBand(base, id) && radioHasBand(rover, id));
  const widthsFor = (id) => {
    const b = radioBand(base, id).widths;
    const r = radioBand(rover, id).widths;
    const both = b.filter((w) => r.includes(w));
    return both.length ? both : [20];
  };
  return {
    base,
    rover,
    bands,
    widthsFor,
    streams: Math.min(base.streams, rover.streams),
    maxMcs: Math.min(base.phy.length, rover.phy.length) - 1,
    txMax: (id) => ({base: radioBand(base, id).txMax, rover: radioBand(rover, id).txMax}),
  };
}

// ---------------------------------------------------------------- RF math

export const log10 = (x) => Math.log(x) / Math.LN10;
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const dbToLin = (db) => Math.pow(10, db / 10);

// Friis, in the engineer's form. d in metres, f in MHz.
export const fspl = (dM, fMHz) => 20 * log10(Math.max(dM, 1) / 1000) + 20 * log10(fMHz) + 32.44;

export const lambdaM = (fMHz) => 299.792458 / fMHz;

// First Fresnel zone radius, metres, at a point d1 along a path of length D.
export const fresnel = (d1, D, fMHz) => {
  const d2 = D - d1;
  if (d1 <= 0 || d2 <= 0) return 0;
  return Math.sqrt((lambdaM(fMHz) * d1 * d2) / D);
};

// Two-ray ground reflection. The direct ray and the ray bouncing off the dirt
// arrive with a path difference, and because the bounce flips phase at grazing
// incidence the pair partly cancels. Below the first maximum they beat in and
// out; past it the cancellation deepens and loss climbs as d^4 instead of d^2.
// Returns dB of EXTRA loss, so a negative number means the reflection is
// helping. This is the single biggest thing a plain Friis budget gets wrong on
// a low-mounted link, and it is why mast height beats antenna gain.
export function groundReflectionDb(D, h1, h2, fMHz, sigmaH = SURFACE_ROUGHNESS) {
  const lam = lambdaM(fMHz);
  const dLos = Math.sqrt(D * D + (h1 - h2) * (h1 - h2));
  const dRef = Math.sqrt(D * D + (h1 + h2) * (h1 + h2));
  const phi = (2 * Math.PI * (dRef - dLos)) / lam;
  // Rayleigh roughness. A rough surface scatters the specular ray away, which
  // is what stops the near-in nulls from being bottomless. On the map this is
  // the real RMS departure of the ground from its own best-fit plane.
  const sinPsi = (h1 + h2) / dRef;
  const rho = Math.exp(-8 * Math.pow((Math.PI * sigmaH * sinPsi) / lam, 2));
  const g = GROUND_GAMMA * rho;
  const re = 1 - g * Math.cos(phi);
  const im = g * Math.sin(phi);
  const amp = Math.sqrt(re * re + im * im);
  return -20 * log10(Math.max(amp, 1e-3));
}

// Directivity from beamwidth. The number every antenna spec sheet has to obey.
export const dirFromBeamwidth = (hDeg, vDeg) => 10 * log10(41253 / (hDeg * vDeg));

// Coax loss is not a constant, it is a curve. Conductor loss goes as the square
// root of frequency and dielectric loss goes linearly; over the decade from 900
// MHz to 5.8 GHz the square-root term dominates, and every cable table agrees
// with it to within a few percent. So a jumper quoted at the band its antenna
// was quoted at is a different jumper on another band: the 0.4 dB LMR-240 that
// feeds a 5.8 GHz panel is 0.16 dB in front of a 900 MHz yagi.
//
// Getting this wrong only ever cost the low bands, which are the ones being
// argued for, so it was a thumb on the scale against 900 MHz.
export const feedAt = (lossDb, refMHz, fMHz) => lossDb * Math.sqrt(fMHz / (refMHz || REF_MHZ));

// Elevation beamwidth of a vertical omni, which is 360 degrees in azimuth.
export const omniVBeam = (gainDbi) => clamp(41253 / (dbToLin(gainDbi) * 360), 3, 120);

// Main-lobe rolloff. -3 dB at half the 3 dB beamwidth, floored at the sidelobes.
export const rolloff = (offDeg, bwDeg, floorDb) =>
  Math.max(-floorDb, -12 * Math.pow(Math.abs(offDeg) / bwDeg, 2));

// ITU-R P.526 single knife-edge diffraction. h is obstruction height above the
// line of sight, so positive h means the ridge is actually in the way. J(v)
// itself lives in terrainModel, because the map view runs it many times per
// path in the multi-edge construction.
export const knifeEdge = (h, d1, d2, fMHz) => {
  if (d1 <= 0 || d2 <= 0) return 0;
  return jv(h * Math.sqrt((2 * (d1 + d2)) / (lambdaM(fMHz) * d1 * d2)));
};

// How finely the real terrain is cut into a profile. Sampling much finer than
// the heightmap only interpolates, and much coarser walks straight over the
// small rises that decide whether a path clears, so the profile follows the
// grid that is actually loaded. 64 spans is the floor (16 m on a 1 km path,
// which is what the bundled 30 m grid supports) and 192 the ceiling, past which
// the Deygout search costs more than it resolves.
export const PROFILE_N = 64;
export const PROFILE_MAX = 192;

export const profileSpans = (D, stepM) =>
  clamp(Math.round(D / Math.max(stepM, 1)), PROFILE_N, PROFILE_MAX);

// Normal upper tail. Zelen & Severo 26.2.17, good to about 7.5e-8.
export function qFunc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.2316419 * z);
  const poly =
    t * (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const q = 0.3989422804014327 * Math.exp(-0.5 * z * z) * poly;
  return x >= 0 ? q : 1 - q;
}

// Fraction of the time a link with this much margin is actually usable.
// Margin of zero means the fade is above the threshold half the time, which is
// why "it closes" and "it works" are different claims.
export const availabilityOf = (marginDb) => clamp(1 - qFunc(marginDb / SHADOW_SIGMA), 0, 1);

// The Part 15 ceiling, expressed as the most EIRP you may legally radiate.
// Point-to-multipoint: 1 dB of conducted power back for every 1 dB of gain
// past 6 dBi, which pins EIRP at 36 dBm no matter how big the antenna gets.
//
// The point-to-point relief in §15.247(b)(3) is granted band by band, and it
// names two: 5725–5850 MHz takes the gain for free, 2400–2483.5 MHz gives back
// 1 dB per 3. 902–928 MHz is not on the list, so a 900 MHz link stays pinned at
// 36 dBm however it is deployed, which is the whole argument against curing a
// 900 MHz path by bolting on a bigger yagi.
export function allowedEirp(mode, band, gainDbi) {
  if (mode === 'off') return Infinity;
  if (mode === 'ptmp' || band === '0.9') return CONDUCTED_MAX + Math.min(gainDbi, 6);
  if (band === '5.8') return CONDUCTED_MAX + gainDbi;
  return CONDUCTED_MAX + gainDbi - Math.max(0, gainDbi - 6) / 3;
}

// ---------------------------------------------------------------- the model

// The synthetic world: flat ground and one adjustable ridge. Heights are
// already above that flat ground, so they double as absolute elevations.
export function ridgeGeometry(p, D, band) {
  const dh = p.roverH - p.baseH;
  const inPath = p.ridgeH > 0 && p.ridgeD > 0 && p.ridgeD < D;
  const dNear = clamp(p.ridgeD, 1, Math.max(D - 1, 1));
  const losAtRidge = p.baseH + dh * (dNear / D);
  const hAboveLos = p.ridgeH - losAtRidge;
  const f1AtRidge = fresnel(dNear, D, band.fMHz);
  return {
    dh,
    baseZ: p.baseH,
    roverZ: p.roverH,
    groundBase: 0,
    groundRover: 0,
    obstruction: inPath ? knifeEdge(hAboveLos, dNear, D - dNear, band.fMHz) : 0,
    clearance: f1AtRidge > 0 ? -hAboveLos / f1AtRidge : 9,
    pinchAt: dNear,
    obstructed: inPath,
    refH1: p.baseH,
    refH2: p.roverH,
    refSigma: SURFACE_ROUGHNESS,
    profile: null,
    bearingOff: p.bearing,
    roverE: 0,
    roverN: 0,
  };
}

// The real world: a baked USGS heightmap, the base wherever it has been dragged
// to, and the rover out along the chosen heading at the chosen distance. Mast
// heights become heights above ground, so a base parked in a wash is genuinely
// worse off than one on a rise.
export function terrainGeometry(p, D, band) {
  const grid = heightGrid(p.site);
  const th = (p.heading * Math.PI) / 180;
  const roverE = p.baseE + D * Math.sin(th);
  const roverN = p.baseN + D * Math.cos(th);

  const groundBase = sampleHeight(grid, p.baseE, p.baseN);
  const groundRover = sampleHeight(grid, roverE, roverN);
  const baseZ = groundBase + p.baseH;
  const roverZ = groundRover + p.roverH;

  const profile = pathProfile(
    grid,
    p.baseE,
    p.baseN,
    roverE,
    roverN,
    D,
    profileSpans(D, SPAN_M / ((grid.n || GRID) - 1)),
  );
  const obstruction = diffractionLoss(profile, D, baseZ, roverZ, band.fMHz);
  const {clearance, at} = worstClearance(profile, D, baseZ, roverZ, band.fMHz);
  const gp = groundPlane(profile, D);

  return {
    dh: roverZ - baseZ,
    baseZ,
    roverZ,
    groundBase,
    groundRover,
    obstruction,
    clearance,
    pinchAt: at,
    obstructed: obstruction > 0.05,
    // The bounce plane is the ground's own best-fit line, and how far the real
    // ground departs from it is the roughness that fills in the nulls.
    refH1: Math.max(0.5, baseZ - gp.h0),
    refH2: Math.max(0.5, roverZ - gp.h1),
    refSigma: Math.max(SURFACE_ROUGHNESS, gp.sigma),
    profile,
    // Off-boresight is no longer dialled in by hand: it is the angle between
    // where the sector is aimed and where the rover actually ended up.
    bearingOff: Math.abs((((p.heading - p.aim) % 360) + 540) % 360 - 180),
    roverE,
    roverN,
  };
}

export function solve(p, distance) {
  const band = BANDS[p.band];
  const w = WIDTHS[p.width];
  const D = distance;
  const onMap = p.site !== 'off';

  // Which radio sits at each end. Left unset, as the doc page leaves it. Both
  // ends are the NetMetal ax, and every number below is what it always was.
  const baseRadio = normalizeRadio(p.baseRadio);
  const roverRadio = normalizeRadio(p.roverRadio);
  const bandOk = radioHasBand(baseRadio, p.band) && radioHasBand(roverRadio, p.band);
  const baseBand = radioBand(baseRadio, p.band);
  const roverBand = radioBand(roverRadio, p.band);
  // Two radios only talk on what they share: the weaker end's stream count and
  // the shorter of the two rate ladders.
  const nRungs = Math.min(baseRadio.phy.length, roverRadio.phy.length);

  // --- how many spatial streams the INSTALLATION can carry
  //
  // A 2x2 radio is only half of a 2x2 link. The other half is two antenna
  // paths that see genuinely different channels, and on a clean line of sight
  // that means two polarizations: co-polar elements a few centimetres apart on
  // a rover mast see almost the same channel, the matrix is rank one, and the
  // second stream has nowhere to live. Buying a dual-chain radio and hanging
  // one omni, or two vertical omnis. Off it is the commonest way to pay for
  // a 2x2 link and fly a 1x1 one.
  //
  // Both are properties of what is bolted to the mast, so they come in with the
  // antenna rather than the radio. Absent, they mean "the installation is not
  // the limit", which is what every setup saved before this existed assumed.
  const chainCap = Math.min(p.baseChains ?? 2, p.roverChains ?? 2);
  const dualPol = (p.baseXpol ?? true) && (p.roverXpol ?? true);
  const rankCap = dualPol ? chainCap : Math.min(chainCap, 1);
  const radioStreams = Math.min(baseRadio.streams, roverRadio.streams);
  const streams = Math.max(1, Math.min(radioStreams, rankCap));
  // Why the link is not running as wide as the radios could, if it is not.
  const streamLimit =
    streams >= radioStreams
      ? null
      : chainCap < radioStreams && chainCap <= rankCap
        ? 'chains'
        : 'polarization';

  // --- geometry, all in metres
  const geo = onMap ? terrainGeometry(p, D, band) : ridgeGeometry(p, D, band);
  const elevDeg = (Math.atan2(geo.dh, D) * 180) / Math.PI;

  // A diffracted path has no clean specular bounce left, so fade the ground
  // reflection out as the terrain takes over.
  const groundFade = clamp(1 - geo.obstruction / 10, 0, 1);
  const groundRaw = groundReflectionDb(D, geo.refH1, geo.refH2, band.fMHz, geo.refSigma);
  const ground = groundRaw * groundFade;

  const obstruction = geo.obstruction;
  const clearance = geo.clearance;
  const ridgeInPath = geo.obstructed;
  const fsplDb = fspl(D, band.fMHz);
  const pathLoss = fsplDb + obstruction + ground;

  // --- antenna gain actually pointed at the other end
  //
  // The sliders describe the antenna at the band it was specified on. 5.8 GHz
  // unless the part in the slot says otherwise, which is what lets a 900 MHz
  // yagi be typed in as the 900 MHz yagi it is rather than as the 5.8 GHz
  // antenna it would have to pretend to be.
  //
  // Away from that band the beamwidths stretch by the wavelength ratio raised
  // to whatever exponent the construction has, and the gain follows from them:
  // a panel loses two dimensions of aperture, a yagi and an omni one each. That
  // is exactly why a dual-band omni gives up ~3.8 dB on 2.4 GHz while a
  // dual-band panel gives up ~7.5 dB.
  const k = (p.baseRefMHz || REF_MHZ) / band.fMHz;
  const stretch = BEAM_STRETCH[p.baseKind] || BEAM_STRETCH.sector;
  const hBeam = Math.min(p.baseHBeam * Math.pow(k, stretch.h), 180);
  const vBeam = Math.min(p.baseVBeam * Math.pow(k, stretch.v), 120);

  // What the two beamwidths say the antenna can possibly do. Claimed gain above
  // this is fiction; well below it is either honest loss or a shy vendor.
  const impliedRef = dirFromBeamwidth(p.baseHBeam, p.baseVBeam);
  const impliedGain = dirFromBeamwidth(hBeam, vBeam);

  // Off its own band the part loses gain, and it loses it as a SHIFT, not as a
  // ceiling. Efficiency, the gap between what the beamwidths allow and what
  // the vendor claims, is a property of the metal and survives the band
  // change, so an antenna quoted 2 dB under its own directivity is still 2 dB
  // under it a band down. Taking the minimum alone quietly handed that gap back
  // as free gain, which flattered every off-band link by exactly the amount the
  // part was honest about. Worst on a base omni, whose stand-in 120 deg azimuth
  // puts the ceiling so far above the claim that it never bound at all and the
  // antenna crossed bands losing nothing.
  //
  // The exponents already carry the physics: stretching both planes by k costs
  // 20log10(k) of directivity, one plane costs 10log10(k), which is the
  // aperture-vs-endfire distinction spelled out in BEAM_STRETCH.
  const bandDrop = 10 * (stretch.h + stretch.v) * log10(k);
  // The ceiling still applies on top, and now it does the one job it is good
  // at: catching a listing that claims more than its own beamwidth allows.
  const baseGain = Math.min(p.baseGain - bandDrop, impliedGain);
  const baseAz = rolloff(geo.bearingOff, hBeam, 25);
  const baseEl = rolloff(elevDeg + p.downtilt, vBeam, 25);
  const baseEff = baseGain + baseAz + baseEl;

  // One dimension of aperture, so gain falls by 10log10 of the ratio measured
  // from the band this element was quoted at. The toroid then widens by the
  // same ratio on its own through the identity below. This is the same law the
  // base slot applies above. BEAM_STRETCH.omni sums to 1, so the same part
  // scores the same on either end of the link.
  const kRover = (p.roverRefMHz || REF_MHZ) / band.fMHz;
  const roverGain = p.roverGain - 10 * log10(kRover);
  const vRover = omniVBeam(roverGain);
  // Signed: pitching the rover toward the base can help, not just hurt.
  const roverOff = Math.abs(p.tilt + elevDeg);
  const roverRolloff = rolloff(roverOff, vRover, 20);
  const roverEff = roverGain + roverRolloff;

  // --- regulatory ceiling, computed on peak gain the way the FCC measures it
  const capBase = allowedEirp(p.reg, p.band, baseGain);
  const capRover = allowedEirp(p.reg, p.band, roverGain);

  // Interference adds to thermal noise in linear power, not in dB. Two equal
  // noise sources make 3 dB, not 0.
  const noiseRise = 10 * log10(1 + dbToLin(p.interference));
  const noiseAdj = w.sens + noiseRise;

  // One direction.
  //
  // The fade is a single random variable that every rate sees at once, so the
  // right question is not "which rung wins on average" but "what does the radio
  // deliver as the fade moves". When the top rung stops decoding you drop to the
  // next one down, you do not drop to zero, and that fallback is most of the
  // throughput on a marginal link.
  //
  // Availability is non-increasing up the ladder, so P(best usable rung >= m)
  // is exactly avail(margin_m), and the expectation telescopes:
  //
  //     E[rate] = sum over rungs of (phy[m] - phy[m-1]) * avail(margin_m)
  //
  // No argmax anywhere, which also means no coin-toss jitter between two rungs
  // of near-equal worth.
  function direction(txSetting, cableTx, gainPeakTx, gainEffTx, cap, gainEffRx, cableRx, txEnd, rxEnd) {
    const rungs = [];
    for (let mcs = 0; mcs < nRungs; mcs++) {
      const tx = Math.min(txSetting, txEnd.band.txMax - txEnd.radio.backoff[mcs]);
      const eirpRaw = tx - cableTx + gainPeakTx;
      const eirp = Math.min(eirpRaw, cap);
      const rx = eirp - (gainPeakTx - gainEffTx) - pathLoss + gainEffRx - cableRx;
      // Sensitivity belongs to whichever radio is listening, not to the link.
      const sens = rxEnd.band.sens[mcs] + noiseAdj;
      const margin = rx - sens;
      rungs.push({
        mcs, tx, eirpRaw, eirp,
        capped: eirpRaw > cap + 0.01,
        rx, sens, margin,
        avail: availabilityOf(margin),
        // A rung only exists if both ends can modulate it.
        phy: Math.min(txEnd.radio.phy[mcs], rxEnd.radio.phy[mcs]) * streams * w.rate,
      });
    }

    // A denser constellation always needs more signal than a sparser one, so
    // this holds on its own. Enforce it anyway: the sum below must never see a
    // negative slice of probability.
    for (let i = 1; i < rungs.length; i++) {
      rungs[i].avail = Math.min(rungs[i].avail, rungs[i - 1].avail);
    }

    let expected = 0;
    let prevPhy = 0;
    for (const rg of rungs) {
      expected += (rg.phy - prevPhy) * rg.avail;
      prevPhy = rg.phy;
    }

    // Whether the link exists at all is a property of the bottom rung: if MCS0
    // cannot be heard, nothing can. That is the number worth calling "uptime".
    const bottom = rungs[0];

    // The rate it sits at on a median fade, which is the fastest rung the
    // signal you actually have will carry. It steps only when a real threshold
    // is crossed, rather than flipping whenever two rungs are near-equal.
    let typical = bottom;
    for (const rg of rungs) if (rg.margin >= 0) typical = rg;

    return {
      ...typical,
      up: bottom.margin >= 0,
      linkMargin: bottom.margin,
      linkAvail: bottom.avail,
      hold: typical.avail, // how much of the drive it holds *this* rate
      expected,
      rungs,
    };
  }

  // The jumpers, on the band this link is actually running rather than the band
  // they were quoted at.
  const baseCable = feedAt(p.baseCable, p.baseRefMHz, band.fMHz);
  const roverCable = feedAt(p.roverCable, p.roverRefMHz, band.fMHz);

  const atBase = {radio: baseRadio, band: baseBand};
  const atRover = {radio: roverRadio, band: roverBand};
  const down = direction(p.baseTx, baseCable, baseGain, baseEff, capBase, roverEff, roverCable, atBase, atRover);
  const up = direction(p.roverTx, roverCable, roverGain, roverEff, capRover, baseEff, baseCable, atRover, atBase);

  // Default Wi-Fi ACK timing assumes an indoor room. Leave it unset on a
  // kilometre link and the retries eat the airtime.
  const ackFactor = p.ackSet ? 1 : D <= 300 ? 1 : Math.max(0.1, 1 - (D - 300) / 1200);

  // The wired side. Traffic crosses a port at each end, so the link is held to
  // the slower of the two, and a Fast Ethernet port is a hard 94 Mbps however
  // good the air is. This is the whole reason the 5.8 GHz Rocket was worth
  // replacing rather than re-aiming, and it is invisible in a pure RF budget.
  const ethCap = Math.min(baseRadio.eth, roverRadio.eth) * ETH_EFFICIENCY;

  // What each direction could carry if it owned the whole channel. This is the
  // fade-averaged expectation, so a link that spends part of its time on a
  // lower rung is counted at what it actually delivers rather than at zero.
  const airOnly = (dir) => dir.expected * MAC_EFFICIENCY * ackFactor;
  const capacity = (dir) => Math.min(airOnly(dir), ethCap);
  const capDown = capacity(down);
  const capUp = capacity(up);
  // True when the radio is being wasted: the air would carry more than the wire
  // will take.
  const ethBound = Math.max(airOnly(down), airOnly(up)) > ethCap + 0.01;

  // One radio pair, one channel, half duplex: the two directions share airtime.
  // Control is inelastic and takes what it needs; video gets the rest. If the
  // two demands add up past 100% the mission does not fit, however good the
  // per-direction Mbps look on their own.
  const airDown = capDown > 0 ? CONTROL_FLOOR / capDown : Infinity;
  const airUpNeed = capUp > 0 ? VIDEO_FLOOR / capUp : Infinity;
  const airtime = airDown + airUpNeed;

  // "Fits" has to mean the mission actually runs, which takes more than the
  // arithmetic closing. A link that carries 8 Mbps whenever it is up, but is
  // only up half the drive, does not fly the mission, so demand both that the
  // two flows fit the airtime and that the link is there to carry them.
  const MISSION_UPTIME = 0.9;
  const linkAvail = Math.min(down.linkAvail, up.linkAvail);
  // The link's margin is the worse direction's, for the same reason its uptime
  // is: a link is only as good as the end that fails first. Exposed at the top
  // level next to linkAvail because everything that asks "how much fade can
  // this take" means the pair, not one direction of it.
  const linkMargin = Math.min(down.linkMargin, up.linkMargin);
  const fits = down.up && up.up && airtime <= 1 && linkAvail >= MISSION_UPTIME;

  return {
    bandOk, streams, radioStreams, streamLimit, chainCap, dualPol,
    ethCap, ethBound, maxMcs: nRungs - 1,
    txMaxBase: baseBand.txMax, txMaxRover: roverBand.txMax,
    D, elevDeg, vBase: vBeam, hBase: hBeam, vRover, impliedGain, impliedRef, bandDrop,
    baseGain, roverGain, baseAz, baseEl, baseEff, roverEff, roverRolloff,
    baseCable, roverCable,
    capBase, capRover, obstruction, ground, groundRaw, clearance,
    ridgeInPath, fsplDb, pathLoss, ackFactor,
    onMap,
    profile: geo.profile,
    baseZ: geo.baseZ, roverZ: geo.roverZ,
    groundBase: geo.groundBase, groundRover: geo.groundRover,
    roverE: geo.roverE, roverN: geo.roverN,
    bearingOff: geo.bearingOff, pinchAt: geo.pinchAt, refSigma: geo.refSigma,
    f1Mid: fresnel(D / 2, D, band.fMHz),
    lateral: D * Math.tan((hBeam / 2) * (Math.PI / 180)),
    down: {...down, capacity: capDown, air: airDown},
    up: {...up, capacity: capUp, air: airUpNeed},
    airtime, fits, linkAvail, linkMargin,
  };
}

// Walk the link out from the radio to wherever it stops working, which is the
// question the sliders cannot answer on their own. Fine near the base, because
// that is where the ground-reflection nulls bunch up.
export function sweepRange(p) {
  // On a map the sweep stops where the real data does, rather than inventing
  // ground past the edge of the heightmap.
  const maxD =
    p.site === 'off'
      ? 5000
      : Math.max(300, Math.min(5000, Math.floor(distanceToEdge(p.baseE, p.baseN, p.heading) / 50) * 50));
  const rows = [];
  let linkRange = null;
  let videoRange = null;
  // A ridge sitting at a fixed distance puts the worst diffraction right behind
  // itself, so the honest answer is often "it drops here and comes back" rather
  // than a single clean range.
  let linkRecovers = false;
  let videoRecovers = false;
  for (let d = 25; d <= maxD; d += d < 400 ? 10 : 50) {
    const s = solve(p, d);
    rows.push({d, up: s.up.capacity, down: s.down.capacity});
    const linkOk = s.up.up && s.down.up;
    if (!linkOk && linkRange === null) linkRange = d;
    else if (linkOk && linkRange !== null) linkRecovers = true;
    if (!s.fits && videoRange === null) videoRange = d;
    else if (s.fits && videoRange !== null) videoRecovers = true;
  }
  return {
    maxD,
    rows,
    linkRange: linkRange === null ? maxD + 1 : linkRange,
    videoRange: videoRange === null ? maxD + 1 : videoRange,
    linkRecovers,
    videoRecovers,
  };
}

// ------------------------------------------------------- concurrent bands
//
// The NetMetal ax runs 2.4 and 5 GHz at the same time on the same diplexed
// pair, and the whole VLAN split exists so Babel can see them as two links. A
// model that solves one band at a time cannot describe that architecture, and
// picking a band in a dropdown quietly asks the wrong question: you do not
// choose a band, you choose which band carries which flow.
//
// So: solve every band both radios have, then say who should carry what.

// How much of the fade the bands share. The deterministic part of a path. Free
// space, diffraction over a ridge, antenna gain. Genuinely differs per band,
// and that is real diversity you can bank. The random shadow fade over the same
// dirt is mostly common to both, and crediting it twice is how a link budget
// talks itself into an availability it does not have.
//
// Rather than pick a correlation and pretend to know it, report both ends:
// fully correlated is the floor, independent is the ceiling, and the honest
// answer is nearer the floor.
export function combineAvailability(avails) {
  if (!avails.length) return {lo: 0, hi: 0};
  const lo = Math.max(...avails);
  const hi = 1 - avails.reduce((acc, a) => acc * (1 - a), 1);
  return {lo, hi};
}

export function solveBands(p, distance) {
  const base = normalizeRadio(p.baseRadio);
  const rover = normalizeRadio(p.roverRadio);
  const ids = Object.keys(BANDS).filter((id) => radioHasBand(base, id) && radioHasBand(rover, id));

  const bands = ids.map((id) => {
    // Each band runs the widest channel both ends tune there, capped by any
    // rule that applies to it. You do not fly 20 MHz on 900 MHz.
    const widths = radioBand(base, id).widths.filter((w) => radioBand(rover, id).widths.includes(w));
    const ruleMax = RULE_MAX_WIDTH[id] ?? Infinity;
    const legal = widths.filter((w) => w <= ruleMax);
    const width = (legal.length ? legal : widths).slice(-1)[0] || 20;
    return {id, label: BANDS[id].label, width, r: solve({...p, band: id, width}, distance)};
  });

  const up = bands.filter((b) => b.r.up.up && b.r.down.up);
  const byVideo = [...up].sort((a, b) => b.r.up.capacity - a.r.up.capacity);
  const byHold = [...up].sort((a, b) => b.r.linkAvail - a.r.linkAvail);

  // Video wants rate, control wants to still be there when the rate is gone.
  // On this rover they are deliberately different answers, which is the entire
  // argument for keeping 900 MHz alive next to a Wi-Fi 6 radio.
  const video = byVideo.find((b) => b.r.up.capacity >= VIDEO_FLOOR) || byVideo[0] || null;
  const control = byHold[0] || null;
  const {lo, hi} = combineAvailability(bands.map((b) => b.r.linkAvail));

  // Split across two radios and each flow owns its own airtime; on one band the
  // two share it, which is what solve() already worked out.
  const split = Boolean(video && control && video.id !== control.id);
  const fits = split
    ? video.r.up.capacity >= VIDEO_FLOOR &&
      control.r.down.capacity >= CONTROL_FLOOR &&
      Math.min(video.r.linkAvail, control.r.linkAvail) >= 0.9
    : Boolean(video && video.r.fits);

  // Both radios come down ONE Ethernet cable, because the NetMetal has one
  // port. Each band's own solve() has already held it to that port, but they
  // are sharing it, not getting one each, so the aggregate is what the wire
  // actually sees. Close in with both bands on their widest legal channel this
  // is the binding constraint: the air is worth more than a gigabit port will
  // carry, and the 2.5G SFP is the way out of it.
  const trunkCap = bands.length
    ? Math.min(...bands.map((b) => b.r.ethCap))
    : 0;
  const airTotal = bands.reduce((a, b) => a + b.r.up.capacity, 0);
  const trunkBound = bands.length > 1 && airTotal > trunkCap + 0.01;

  return {
    bands, video, control, split, fits, availLo: lo, availHi: hi, ids,
    trunkCap, airTotal, trunkBound,
  };
}

// ------------------------------------------------------------- sensitivity
//
// "What is actually limiting this link right now?" is the question the sliders
// cannot answer, because every one of them moves the number and none of them
// says by how much relative to the others. Perturb each knob by a step someone
// could really take, re-solve, and rank by what it bought.
//
// The metric is the worse direction's bottom-rung margin, which is the dB the
// link is up or down by, not the headline Mbps, which can improve while the
// link gets less reliable.

const marginOf = (r) => Math.min(r.up.linkMargin, r.down.linkMargin);

// Each entry is a move you could actually make on a Tuesday, not a unit step:
// one more metre of mast, one antenna class up, the short jumper instead of the
// long one. That is what makes the ranking a to-do list rather than a gradient.
export const LEVERS = [
  {key: 'baseH', label: 'Raise the mast', delta: 1, unit: 'm', max: 12,
   note: 'rule 3.b.iv caps this at 3 m'},
  {key: 'roverH', label: 'Raise the rover element', delta: 0.5, unit: 'm', max: 3},
  {key: 'baseGain', label: 'Bigger base antenna', delta: 3, unit: 'dB', max: 30,
   note: 'narrows the beam by the same arithmetic'},
  {key: 'roverGain', label: 'Bigger rover antenna', delta: 3, unit: 'dB', max: 12,
   note: 'and a shorter toroid to fall out of'},
  {key: 'baseCable', label: 'Shorten the base jumper', delta: -1, unit: 'dB', min: 0},
  {key: 'roverCable', label: 'Shorten the rover pigtail', delta: -0.3, unit: 'dB', min: 0},
  {key: 'baseTx', label: 'More base TX power', delta: 3, unit: 'dB'},
  {key: 'roverTx', label: 'More rover TX power', delta: 3, unit: 'dB'},
  {key: 'downtilt', label: 'Remove downtilt', delta: -5, unit: '°', min: 0},
  {key: 'interference', label: 'Quieter channel', delta: -6, unit: 'dB', min: -20},
  {key: 'distance', label: 'Drive 200 m closer', delta: -200, unit: 'm', min: 50},
];

// A lever that buys nothing is the most interesting row in the table, and there
// are three quite different ways to buy nothing. Saying which one turns a list
// of zeroes into the argument the page is trying to make.
function whyNothing(base, next) {
  const tight = base.up.linkMargin <= base.down.linkMargin ? 'up' : 'down';
  const slack = tight === 'up' ? 'down' : 'up';
  const helped = next[tight].linkMargin - base[tight].linkMargin;
  const other = next[slack].linkMargin - base[slack].linkMargin;
  if (Math.abs(helped) > 0.05) return null;

  // Transmit-side money on a link already pinned at the Part 15 ceiling: the
  // lever raised what the radio wanted to radiate and the law took all of it.
  // Read off eirpRaw rather than guessed from the lever's name, so it cannot
  // blame the cap for something on the other side of the link. The rover's TX
  // power is nowhere near the ceiling even when the base is sitting on it.
  //
  // Read at the BOTTOM rung, because that is the rung linkMargin belongs to.
  // The typical rung is wherever rate control has settled, and up there the
  // radio's own backoff has usually taken the power below the TX setting, so it
  // would report a knob as inert that is squarely against the legal ceiling.
  const b0 = base[tight].rungs[0];
  const n0 = next[tight].rungs[0];
  if (n0.eirpRaw > b0.eirpRaw + 0.05 && b0.capped && n0.capped) {
    return 'absorbed by the Part 15 EIRP cap. You are already radiating the legal maximum';
  }
  if (Math.abs(other) > 0.25) {
    return `only helps ${slack === 'up' ? 'rover → base' : 'base → rover'}, which is not the tight direction`;
  }
  return 'this link is not limited by that';
}

export function sensitivity(p, distance) {
  const at = (patch, d) => solve({...p, ...patch}, d ?? distance);
  const base = at({}, distance);
  const ref = marginOf(base);
  const refRate = Math.min(base.up.capacity, base.down.capacity);

  const score = (lv, next, from, to, available) => ({
    ...lv,
    from,
    to,
    available,
    gain: available ? marginOf(next) - ref : 0,
    dUp: available ? next.up.linkMargin - base.up.linkMargin : 0,
    dDown: available ? next.down.linkMargin - base.down.linkMargin : 0,
    // What it costs. Margin bought by throwing away rate is still worth having
    //. This link needs 8 Mbps and has hundreds, but it should be on the label.
    rateFrom: refRate,
    rateTo: available ? Math.min(next.up.capacity, next.down.capacity) : refRate,
    why: available ? whyNothing(base, next) : 'already at its limit',
  });

  const rows = LEVERS.map((lv) => {
    const now = lv.key === 'distance' ? distance : p[lv.key];
    let to = now + lv.delta;
    if (lv.min !== undefined) to = Math.max(lv.min, to);
    if (lv.max !== undefined) to = Math.min(lv.max, to);
    // A lever already at its stop is not a small win, it is not available, and
    // saying so is more useful than reporting a zero it has to share with
    // everything that genuinely does nothing.
    const moved = Math.abs(to - now) > 1e-9;
    const next = lv.key === 'distance' ? at({}, to) : at({[lv.key]: to}, distance);
    return score(lv, next, now, to, moved);
  });

  // Channel width is not a slider you nudge, it is a choice, so it is scored
  // against the next narrower legal option instead of against a delta.
  const ruleMax = RULE_MAX_WIDTH[p.band] ?? Infinity;
  const widths = Object.keys(WIDTHS)
    .map(Number)
    .filter((w) => w < p.width && w <= ruleMax)
    .sort((a, b) => a - b);
  const narrower = widths[widths.length - 1];
  if (narrower) {
    rows.push(
      score(
        {key: 'width', label: `Narrow the channel to ${narrower} MHz`, unit: 'MHz',
         note: 'every halving of bandwidth is about 3 dB of noise floor'},
        at({width: narrower}, distance), p.width, narrower, true,
      ),
    );
  }

  return {
    ref,
    tight: base.up.linkMargin <= base.down.linkMargin ? 'up' : 'down',
    rows: rows.sort((a, b) => b.gain - a.gain),
  };
}

// --------------------------------------------------------------- coverage
//
// Everything else on this page answers "does the link work where the rover is
// standing". The question a siting argument actually turns on is "where can the
// rover GO", and that is a shape, not a number.
//
// Swept in polar coordinates around the base, because that is how the answer is
// shaped. A lobe, not a rectangle, and because it costs a fiftieth of what a
// Cartesian raster of the same fidelity would.

export const COVER_BEARINGS = 72; // every 5 degrees
export const COVER_RANGES = 44;

// What a cell is worth. Uptime is the honest default: a cell where the link
// exists 60% of the drive is not a cell you can work in, whatever its Mbps say.
export const COVER_METRICS = {
  uptime: {label: 'Link uptime', pick: (r) => r.linkAvail, fmt: (v) => `${(v * 100).toFixed(0)}%`},
  video: {label: 'Video fits', pick: (r) => (r.fits ? 1 : 0), fmt: (v) => (v > 0.5 ? 'yes' : 'no')},
  rate: {label: 'Rover → base Mbps', pick: (r) => r.up.capacity, fmt: (v) => `${v.toFixed(0)}`},
};

// One bearing's worth of the sweep. Handing back a row at a time is what lets
// the caller spread ~3000 solves over several frames instead of freezing the
// page for a second and a half every time a slider moves.
export function coverageRow(p, bearing, maxD, nRanges = COVER_RANGES) {
  const out = new Float64Array(nRanges);
  const fitsRow = new Uint8Array(nRanges);
  const rates = new Float64Array(nRanges);
  for (let i = 0; i < nRanges; i++) {
    const d = ((i + 1) / nRanges) * maxD;
    const r = solve({...p, heading: bearing}, d);
    out[i] = r.linkAvail;
    fitsRow[i] = r.fits ? 1 : 0;
    rates[i] = r.up.capacity;
  }
  return {bearing, uptime: out, fits: fitsRow, rate: rates};
}

// How far out the sweep should look: past the point the link has been dead for
// a while there is nothing left to draw, and on a map there is no ground either.
export function coverageReach(p) {
  if (p.site === 'off') return 3000;
  let reach = 0;
  for (let b = 0; b < 360; b += 30) reach = Math.max(reach, distanceToEdge(p.baseE, p.baseN, b));
  return clamp(Math.round(reach / 100) * 100, 500, 4000);
}

// The whole sweep. ~3200 solves, which measures at about 35 ms on the bundled
// grid and roughly triple that once the fine heightmap has landed. Fast enough
// to run inline, slow enough that the caller should not run it on every frame
// of a drag.
export function coverageField(p, reach, nB = COVER_BEARINGS, nR = COVER_RANGES) {
  const uptime = new Float32Array(nB * nR);
  const fits = new Uint8Array(nB * nR);
  const rate = new Float32Array(nB * nR);
  for (let b = 0; b < nB; b++) {
    const row = coverageRow(p, (b * 360) / nB, reach, nR);
    for (let i = 0; i < nR; i++) {
      uptime[b * nR + i] = row.uptime[i];
      fits[b * nR + i] = row.fits[i];
      rate[b * nR + i] = row.rate[i];
    }
  }
  // The headline the picture is for, in square kilometres of ground you can
  // actually work in.
  //
  // Not a percentage: the denominator would be the disc the sweep happened to
  // cover, which is set by where the heightmap runs out rather than by anything
  // about the link. A build that reaches 1.5 km scored 7% against a 3.8 km disc
  // and 60% against a 2 km one, having done exactly the same thing both times.
  // An area is the same number whatever the sweep did, so two builds can be
  // compared by it.
  let workableM2 = 0;
  for (let b = 0; b < nB; b++) {
    for (let i = 0; i < nR; i++) {
      if (!fits[b * nR + i]) continue;
      const r0 = (i / nR) * reach;
      const r1 = ((i + 1) / nR) * reach;
      workableM2 += (Math.PI * (r1 * r1 - r0 * r0)) / nB;
    }
  }
  return {nB, nR, reach, uptime, fits, rate, workableKm2: workableM2 / 1e6};
}

// Everything the sweep depends on. Deliberately NOT the rover's position, which
// is the one thing a coverage map is supposed to be independent of. Used as a
// memo key so dragging the rover around never re-runs three thousand solves.
export function coverageSignature(p) {
  return [
    p.site, p.baseE, p.baseN, p.baseH, p.roverH, p.band, p.width,
    p.baseTx, p.roverTx, p.baseGain, p.baseHBeam, p.baseVBeam, p.baseCable,
    p.baseKind, p.baseRefMHz, p.roverGain, p.roverCable, p.roverRefMHz,
    p.aim, p.downtilt, p.tilt, p.reg, p.interference, p.ackSet,
    p.baseChains, p.baseXpol, p.roverChains, p.roverXpol,
    p.ridgeH, p.ridgeD, p.bearing,
    p.baseRadio && p.baseRadio.id, p.roverRadio && p.roverRadio.id,
  ].join('|');
}

export const DEFAULTS = {
  band: '5.8',
  width: 20,
  distance: 1000,
  baseH: 3,
  roverH: 1.2,
  ridgeH: 0,
  ridgeD: 500,
  baseTx: 25,
  baseGain: 18,
  baseHBeam: 20,
  baseVBeam: 20,
  baseCable: 0.4,
  // What the antenna is and what band its numbers came off. Absent, as every
  // saved setup from before the gear library was band-aware leaves them. The
  // model reads a 5.8 GHz panel, which is what those numbers always meant.
  baseKind: 'sector',
  baseRefMHz: REF_MHZ,
  roverRefMHz: REF_MHZ,
  // What the mast can actually carry. Two cross-polarised paths at each end is
  // what the BOM is trying to buy, so it is what the defaults describe.
  baseChains: 2,
  baseXpol: true,
  roverChains: 2,
  roverXpol: true,
  downtilt: 0,
  bearing: 0,
  roverTx: 25,
  roverGain: 6.7,
  roverCable: 0.3,
  tilt: 0,
  reg: 'ptmp',
  interference: -20,
  ackSet: true,
  // Map view. 'off' keeps the synthetic flat-desert-plus-one-ridge world; a
  // site id swaps in real USGS terrain and derives the geometry from it.
  site: 'off',
  baseE: 0,
  baseN: 0,
  aim: 45, // compass bearing the sector is pointed at
  heading: 45, // compass bearing from base to rover
};

export const PRESETS = {
  'NetMetal ax + panel, 1 km clear': {},
  'Mast dropped to 1 m': {baseH: 1},
  'Cheap ALFA pair instead': {baseGain: 10, baseHBeam: 66, baseVBeam: 16},
  'The 25 m coax mistake': {baseCable: 18},
  'Rover pitched on a slope': {tilt: 22, roverGain: 9},
  // Two of the same omni is two chains and one channel. The radio still says
  // 2x2 on the box, and the link still runs at half of it.
  'Two vertical omnis on the rover': {roverXpol: false},
  // Back to the synthetic world: a real heightmap would ignore these sliders.
  'Behind a ridge': {site: 'off', ridgeH: 8, ridgeD: 450},
  'Wrong downtilt bracket': {baseGain: 15, baseHBeam: 90, baseVBeam: 7, downtilt: 10},
  'Antenna with a fake spec sheet': {baseGain: 24, baseHBeam: 90, baseVBeam: 20},
  'Competition day interference': {interference: 14},
  'ACK timeout left at default': {ackSet: false},
};

