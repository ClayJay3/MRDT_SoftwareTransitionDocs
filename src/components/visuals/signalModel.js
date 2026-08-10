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
  diffractionLoss,
  groundPlane,
  heightGrid,
  jv,
  pathProfile,
  sampleHeight,
  worstClearance,
} from './terrainModel';


// ---------------------------------------------------------------- constants

// Antenna sliders are specified at 5.8 GHz. Everything else scales off that.
export const REF_MHZ = 5800;

export const BANDS = {
  '2.4': {label: '2.4 GHz', fMHz: 2437, sensAdj: -1, txMax: 30, widths: [10, 20, 40]},
  '5.8': {label: '5.8 GHz', fMHz: 5800, sensAdj: 0, txMax: 28, widths: [10, 20, 40, 80]},
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

// How finely the real terrain is cut into a profile. 65 points over a 1 km path
// is 16 m a sample, comfortably inside the 30 m heightmap grid.
export const PROFILE_N = 64;

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
// Point-to-point: 5.8 GHz gets the gain for free, 2.4 GHz gives back 1 dB per 3.
export function allowedEirp(mode, band, gainDbi) {
  if (mode === 'off') return Infinity;
  if (mode === 'ptmp') return CONDUCTED_MAX + Math.min(gainDbi, 6);
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

  const profile = pathProfile(grid, p.baseE, p.baseN, roverE, roverN, D, PROFILE_N);
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
  // The sliders describe the antenna at 5.8 GHz. An aperture keeps its physical
  // size, not its beamwidth, so dropping to 2.4 GHz stretches every beamwidth by
  // the wavelength ratio. A panel loses two dimensions of aperture and the omni
  // only one, which is exactly why a dual-band omni gives up ~3.8 dB on 2.4
  // while a dual-band panel gives up ~7.5 dB.
  const k = REF_MHZ / band.fMHz;
  const hBeam = Math.min(p.baseHBeam * k, 180);
  const vBeam = Math.min(p.baseVBeam * k, 120);

  // What the two beamwidths say the antenna can possibly do. Claimed gain above
  // this is fiction; well below it is either honest loss or a shy vendor.
  // Directivity is a hard ceiling, so a listing claiming more than its own
  // beamwidth allows gets derated to what the geometry can actually produce.
  const impliedRef = dirFromBeamwidth(p.baseHBeam, p.baseVBeam);
  const impliedGain = dirFromBeamwidth(hBeam, vBeam);
  const baseGain = Math.min(p.baseGain, impliedGain);
  const baseAz = rolloff(geo.bearingOff, hBeam, 25);
  const baseEl = rolloff(elevDeg + p.downtilt, vBeam, 25);
  const baseEff = baseGain + baseAz + baseEl;

  // One dimension of aperture, so gain falls by 10log10 of the ratio. The
  // toroid then widens by the same ratio on its own through the identity below.
  const roverGain = p.roverGain - 10 * log10(k);
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
  const noiseAdj = w.sens + noiseRise + band.sensAdj;
  const sensOf = (mcs) => SENS20[mcs] + noiseAdj;

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
  function direction(txMax, cableTx, gainPeakTx, gainEffTx, cap, gainEffRx, cableRx) {
    const rungs = [];
    for (let mcs = 0; mcs <= 11; mcs++) {
      const tx = Math.min(txMax, band.txMax - TX_BACKOFF[mcs]);
      const eirpRaw = tx - cableTx + gainPeakTx;
      const eirp = Math.min(eirpRaw, cap);
      const rx = eirp - (gainPeakTx - gainEffTx) - pathLoss + gainEffRx - cableRx;
      const sens = sensOf(mcs);
      const margin = rx - sens;
      rungs.push({
        mcs, tx, eirpRaw, eirp,
        capped: eirpRaw > cap + 0.01,
        rx, sens, margin,
        avail: availabilityOf(margin),
        phy: PHY20[mcs] * STREAMS * w.rate,
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

  const down = direction(p.baseTx, p.baseCable, baseGain, baseEff, capBase, roverEff, p.roverCable);
  const up = direction(p.roverTx, p.roverCable, roverGain, roverEff, capRover, baseEff, p.baseCable);

  // Default Wi-Fi ACK timing assumes an indoor room. Leave it unset on a
  // kilometre link and the retries eat the airtime.
  const ackFactor = p.ackSet ? 1 : D <= 300 ? 1 : Math.max(0.1, 1 - (D - 300) / 1200);

  // What each direction could carry if it owned the whole channel. This is the
  // fade-averaged expectation, so a link that spends part of its time on a
  // lower rung is counted at what it actually delivers rather than at zero.
  const capacity = (dir) => dir.expected * MAC_EFFICIENCY * ackFactor;
  const capDown = capacity(down);
  const capUp = capacity(up);

  // One radio pair, one channel, half duplex: the two directions share airtime.
  // Control is inelastic and takes what it needs; video gets the rest. If the
  // two demands add up past 100% the mission does not fit, however good the
  // per-direction Mbps look on their own.
  const airDown = capDown > 0 ? CONTROL_FLOOR / capDown : Infinity;
  const airUpNeed = capUp > 0 ? VIDEO_FLOOR / capUp : Infinity;
  const airtime = airDown + airUpNeed;

  // "Fits" has to mean the mission actually runs, which takes more than the
  // arithmetic closing. A link that carries 8 Mbps whenever it is up, but is
  // only up half the drive, does not fly the mission — so demand both that the
  // two flows fit the airtime and that the link is there to carry them.
  const MISSION_UPTIME = 0.9;
  const linkAvail = Math.min(down.linkAvail, up.linkAvail);
  const fits = down.up && up.up && airtime <= 1 && linkAvail >= MISSION_UPTIME;

  return {
    D, elevDeg, vBase: vBeam, hBase: hBeam, vRover, impliedGain, impliedRef,
    baseGain, roverGain, baseAz, baseEl, baseEff, roverEff, roverRolloff,
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
    airtime, fits, linkAvail,
  };
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
  // Back to the synthetic world: a real heightmap would ignore these sliders.
  'Behind a ridge': {site: 'off', ridgeH: 8, ridgeD: 450},
  'Wrong downtilt bracket': {baseGain: 15, baseHBeam: 90, baseVBeam: 7, downtilt: 10},
  'Antenna with a fake spec sheet': {baseGain: 24, baseHBeam: 90, baseVBeam: 20},
  'Competition day interference': {interference: 14},
  'ACK timeout left at default': {ackSet: false},
};

