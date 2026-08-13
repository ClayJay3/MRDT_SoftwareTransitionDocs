// Every explanation the link lab can pop up, in one dictionary.
//
// Both the doc-page embed and the studio pull from here, so a number is
// described once and cannot end up explained two different ways. Keys are
// referenced by <Help id="..."/>; a key with no entry renders nothing rather
// than throwing, so a typo degrades to a missing badge.
//
// House style: say what the number IS, then what it DOES to the link. Where a
// figure is load-bearing on the signals page, quote it. The point of these is
// to stop someone having to go and re-read the article mid-experiment.

export const HELP = {
  // ------------------------------------------------------------- the bench

  gearBaseRadio: {
    title: 'Base radio',
    text: 'The radio at the C2 end. It supplies the transmit power and channel widths for that end, and the receive sensitivity the rover is heard with. Pick one from the gear library or define your own off a datasheet.',
  },
  gearRoverRadio: {
    title: 'Rover radio',
    text: 'The radio on the rover. The pair only talks on what both ends share: the shorter rate ladder, the weaker stream count, and the bands and channel widths they have in common.',
  },
  gearBaseAnt: {
    title: 'Base antenna',
    text: 'The antenna on the mast. Selecting one writes the four sliders below it. Move any of them and the slot reads “edited” until you either save it as a new part or pick the old one again.',
  },
  gearRoverAnt: {
    title: 'Rover antenna',
    text: 'The element on the rover, modelled as a vertical omni whose toroid height follows from its gain. A sector dropped in this slot contributes its gain only. Its azimuth pattern is not used.',
  },
  scenario: {
    title: 'Scenarios',
    text: 'Preset link setups, each one a mistake this page exists to prevent. They reset the radio settings but leave your terrain, base position and aim alone, so you see what the mistake costs on the bench you are actually looking at.',
  },

  // ---------------------------------------------------------------- geometry

  distance: {
    title: 'Distance',
    text: 'Straight-line ground distance from base to rover. URC does not expect the rover past 1 km of C2 (rule 2.b.ii). On a map this is set by dragging the rover; the slider and the map are the same number.',
  },
  baseH: {
    title: 'Base mast height',
    text: 'Height of the base antenna above the ground it stands on, and the single most powerful number on this page. It sets where the two-ray ground reflection turns over, so at 1 km on 5.8 GHz a 1 m mast costs about 11 dB against free space, 3 m costs 1.5, and 6 m is 3.6 dB better than free space. URC caps it at 3 m (rule 3.b.iv).',
  },
  roverH: {
    title: 'Rover antenna height',
    text: 'Height of the rover element above the ground under it. It multiplies with the mast in the ground-reflection crossover (4π·h₁·h₂/λ), so a low rover antenna costs you just as much as a low mast.',
  },
  ridgeH: {
    title: 'Ridge height',
    text: 'Height of a single synthetic ridge between base and rover, in the flat-desert world. 0 means a clear path. Ignored once a real heightmap is loaded, because the terrain drives the profile instead.',
  },
  ridgeD: {
    title: 'Ridge distance from base',
    text: 'Where that ridge sits along the path. Diffraction is worst when an obstruction is near the middle of the link and nothing happens at all once it is past the rover.',
  },

  // ------------------------------------------------------------ base station

  baseTx: {
    title: 'Base TX power',
    text: 'Conducted power at the radio’s connector, before cable loss and antenna gain. It stops at the radio’s own rating for this band, and the radio backs itself off further as the modulation gets denser, reaching 8 dB by MCS11 on the NetMetal ax.',
  },
  baseGain: {
    title: 'Claimed gain',
    text: 'Peak gain of the base antenna, as the spec sheet claims it, at the band the part was measured on, and the label says which. Directivity is a hard ceiling, D ≈ 41253/(H°×V°), so a claim the beamwidths cannot support is quietly derated to what the geometry actually allows.',
  },
  baseHBeam: {
    title: 'Azimuth beamwidth',
    text: 'Horizontal 3 dB beamwidth at the band this antenna was quoted on. This is what you are really buying when you buy gain: it sets how wide a corridor the rover can drive in before it falls off the side of the beam. ±176 m at 1 km for a 20° sector, ±649 m for a 66° one.',
  },
  baseVBeam: {
    title: 'Elevation beamwidth',
    text: 'Vertical 3 dB beamwidth. Narrow elevation beams are what make downtilt dangerous: a 15 dBi 90° sector has only 7° of elevation beam, so 10° of tilt from a 3 m mast puts the main lobe in the dirt 17 m away. Run the link on another band and this stretches: by the wavelength ratio for an aperture, by its square root for a yagi.',
  },
  bearing: {
    title: 'Rover off boresight',
    text: 'Angle between where the sector points and where the rover actually is. Gain falls off as −12·(θ/θ₃dB)², floored at the sidelobe level. On a map this stops being a slider: it is computed from the aim handle and the rover’s bearing.',
  },
  downtilt: {
    title: 'Mechanical downtilt',
    text: 'How far the sector is tilted below horizontal. On a 3 m mast talking to a rover 1 km away the path is essentially level, so almost any downtilt aims the main lobe at the ground a few tens of metres in front of you. Mount it flat.',
  },
  baseCable: {
    title: 'Coax loss, base',
    text: 'Loss in the jumper between radio and base antenna. It costs you twice, once transmitting and again receiving. 1 m of LMR-240 is about 0.4 dB at 5.8 GHz; 25 m of LMR-400 is about 18 dB, which is why the radio belongs at the antenna and the long run is Ethernet.',
  },

  // -------------------------------------------------------------------- rover

  roverTx: {
    title: 'Rover TX power',
    text: 'Conducted power at the rover radio. The rover is the weak transmitter in this link, roughly 26 to 30 dBm EIRP against the base station’s 36, which is why base antenna gain, being receive gain, is what buys margin.',
  },
  roverGain: {
    title: 'Rover antenna gain',
    text: 'Peak gain of the rover element, at the band it was quoted on. Deliberately low: gain on an omni buys itself by flattening the pattern, and a flat pattern falls off the rover the moment it pitches. Being one dimension of aperture, the same element gives up 3.8 dB moving from 5.8 to 2.4 GHz and 8 dB more again down to 900 MHz.',
  },
  tilt: {
    title: 'Pitch on the slope',
    text: 'How far the rover is pitched from level, which tilts its whole radiation toroid with it. On a 1 km link, 22° of pitch puts the base station 20 dB down a 9 dBi omni’s pattern but only 1.7 dB down a 3 dBi one. Negative values pitch the toroid toward the base.',
  },
  roverCable: {
    title: 'Pigtail loss',
    text: 'Loss in the short lead between rover radio and element. Worth a fraction of a dB if it is a proper pigtail, and worth 7 dB per side if you use the 5 m of RG58 that came in the box.',
  },

  // -------------------------------------------------------- channel and rules

  band: {
    title: 'Band',
    text: '2.4 GHz has 8 dB less free-space loss and wider, more forgiving beams; 5.8 GHz has the rate and the cleaner spectrum. The panel gives up 7.5 dB of gain moving down to 2.4, so most of that 8 dB comes straight back. 900 MHz goes further still, with 16 dB of free-space loss and a wavelength that diffracts over a ridge instead of stopping at it, but the whole band is 26 MHz wide, so the rate ceiling arrives long before the range does. Only bands both radios support are offered.',
  },
  width: {
    title: 'Channel width',
    text: 'Doubling the channel doubles the PHY rate and raises the noise floor by 10log₁₀(BW/20), so every halving buys about 3 dB of margin. The mission needs 8 Mbps, not 2400. Only widths both radios tune are offered.',
  },
  reg: {
    title: 'Part 15 mode',
    text: 'Which FCC EIRP ceiling to enforce, computed on peak gain the way it is measured. Multipoint gives back 1 dB of conducted power per 1 dB of gain past 6 dBi, pinning EIRP at 36 dBm however big the antenna. Point to point is the relaxation for a link aimed at one fixed remote, and §15.247(b)(3) grants it band by band: 5.8 GHz hands you the gain free, 2.4 GHz takes back 1 dB per 3, and 900 MHz is not on the list at all, so a 900 MHz yagi buys you pattern and reach, never EIRP. Ignore is there to show what the rules cost you, not as an operating mode.',
  },
  interference: {
    title: 'Interference vs thermal',
    text: 'External interference power relative to the receiver’s own thermal noise. Added in linear power, not in dB, so a jammer level with the noise floor costs 3 dB rather than nothing. Competition day is realistically +10 to +15.',
  },
  ackSet: {
    title: 'ACK timeout',
    text: 'Default Wi-Fi ACK timing assumes an indoor room. Left at default on a kilometre link the retries eat the airtime, and the lab scales throughput down past 300 m to represent it. Setting it is free and it is the first thing to get wrong.',
  },

  // -------------------------------------------------------------- ground truth

  site: {
    title: 'Ground',
    text: 'Real 6 km USGS heightmaps over USGS orthoimagery, where mast heights become heights above real ground and the path profile is cut out of the terrain. The page draws on a 30 m grid immediately, then swaps in the 11.7 m one as soon as it has fetched it. Switching sites moves the base to a known-clear starting point on that map. The doc-page version of this lab also offers a synthetic flat world with one adjustable ridge, which is the only place the two-ray ground bounce shows up at all: real ground is too rough to reflect coherently, so on a map that term goes to nothing.',
  },
  aim: {
    title: 'Sector aim',
    text: 'Compass bearing the base sector points at. The difference between this and the rover’s bearing is the off-boresight angle that costs you gain. Rule 3.b.iii allows steering it electronically from C2 on RSSI or relayed GNSS, just not by eye.',
  },
  heading: {
    title: 'Rover heading',
    text: 'Compass bearing from the base station to the rover. With distance, this is where the rover is; drag the rover on the map and both change together.',
  },
  baseE: {
    title: 'Base east of centre',
    text: 'Where the tripod is parked, east–west, relative to the middle of the heightmap. Siting is the biggest lever you have: rule 3.b.iv keeps the antenna within 5 m of C2, but a judge may allow 20 m at MDRS structures. Always ask.',
  },
  baseN: {
    title: 'Base north of centre',
    text: 'Where the tripod is parked, north–south, relative to the middle of the heightmap. Moving it onto a natural rise outperforms any antenna you can buy.',
  },

  // ------------------------------------------------------- per-direction rows

  dirTx: {
    title: 'Radio TX',
    text: 'Conducted power the radio is actually using at the rate shown: your slider, or the radio’s own ceiling for that rung once it backs off for the denser constellation, whichever is lower.',
  },
  dirEirp: {
    title: 'EIRP',
    text: 'Effective radiated power: conducted power − cable loss + peak antenna gain, then clipped to the Part 15 ceiling. “Capped from” means the rules are throwing the difference away and more antenna gain on this end buys you nothing.',
  },
  dirRx: {
    title: 'Received',
    text: 'Signal level arriving at the far receiver, after path loss and the off-axis gain of both antennas. Compare it against the sensitivity of the rung you want.',
  },
  dirRate: {
    title: 'Usual rate',
    text: 'The fastest rung whose threshold the median signal clears, and its PHY rate. “Held” is the fraction of the drive that rung survives the fade. A link can hold its top rate only 60% of the time and still be up 100% of the time, simply running a notch slower through the fades.',
  },
  dirMargin: {
    title: 'Margin there',
    text: 'How far the received signal sits above the sensitivity of the usual rate. This is margin at that rung only. When it runs out the radio steps down a rung, it does not lose the link.',
  },
  dirLinkMargin: {
    title: 'Link margin',
    text: 'Margin at the bottom rung, MCS0. This is how much fade the link can absorb before there is no link at all, which makes it the number to buy more of.',
  },
  dirUptime: {
    title: 'Link uptime',
    text: 'Fraction of the drive the bottom rung is decodable, given a log-normal fade of 5 dB sigma. This is the number that actually fails: anything under 100% means the link itself is dropping out, not just running slower.',
  },
  dirCapacity: {
    title: 'Capacity',
    text: 'What this direction would carry if it owned the whole channel: the fade-averaged expectation across the entire rate ladder, times MAC efficiency. Both directions share one half-duplex channel, so you cannot have both of these at once.',
  },
  dirAirtime: {
    title: 'Airtime',
    text: 'Share of the channel this direction’s traffic actually needs: 0.5 Mbps of control down, 8 Mbps of H.265 video up. When the two add past 100% the mission does not fit, however healthy the per-direction Mbps look.',
  },

  // ---------------------------------------------------------------- the path

  fspl: {
    title: 'Free space loss',
    text: 'Friis, in the engineer’s form: 20log₁₀(d_km) + 20log₁₀(f_MHz) + 32.44. 108 dB at 1 km on 5.8 GHz, 100 dB on 2.4. It is the number everyone budgets and the one that misleads on a low-mounted link.',
  },
  groundBounce: {
    title: 'Ground bounce',
    text: 'Extra loss from the ray reflecting off the dirt, summed coherently with the direct ray. The bounce flips phase at grazing incidence so the two partly cancel; past the crossover at 4π·h₁·h₂/λ the cancellation deepens and loss climbs as d⁴ instead of d². Negative means the reflection is helping you.',
  },
  obstruction: {
    title: 'Obstruction',
    text: 'Knife-edge diffraction loss for terrain intruding into the path, ITU-R P.526. On a real heightmap several edges are scored with the Deygout construction: dominant edge first, then one either side.',
  },
  pathLoss: {
    title: 'Total path loss',
    text: 'Free space plus ground bounce plus obstruction: everything the air does to the signal between the two antennas.',
  },
  f1: {
    title: 'Fresnel radius',
    text: '√(λ·d₁·d₂/D) at the midpoint, the radius of the first Fresnel zone, the volume around the line of sight that has to stay clear. At 1 km it is 3.6 m on 5.8 GHz and 5.6 m on 2.4, which a 3 m mast cannot clear over rolling ground.',
  },
  clearance: {
    title: 'Clearance',
    text: 'How much of the first Fresnel radius is unobstructed at the worst point. Diffraction loss starts once you drop below about 60%, which is where the old rule of thumb comes from. Negative means the terrain is above the line of sight.',
  },
  airtimeTotal: {
    title: 'Airtime used',
    text: 'Both directions’ demands added together on the one half-duplex channel. Past 100% the mission does not fit. This is the number to watch instead of the headline Mbps.',
  },
  linkRange: {
    title: 'Link first drops at',
    text: 'The nearest distance along this heading where even the bottom rung stops holding. “Then recovers” means it comes back further out, because a fixed obstruction shadows a band of range rather than everything beyond it.',
  },
  videoRange: {
    title: 'Video first drops at',
    text: 'The nearest distance where the mission stops fitting: both directions up, the two flows inside 100% airtime, and the link there at least 90% of the drive. Whichever of those fails first sets this number.',
  },

  // -------------------------------------------------------------- the ground

  siteData: {
    title: 'Where this ground comes from',
    text: 'A 6 km square baked from USGS 3DEP elevation, over USGS National Map orthoimagery, committed to the repo so the page never depends on a live API to render. Elevation ships at 30 m in the bundle and upgrades to 11.7 m, 3DEP\'s own resolution, from a file the browser fetches once. The imagery ships at 2.9 m and sharpens to 1.9 m from live USGS tiles as you zoom in. Every value was spot-checked against the USGS ned10m service.',
  },
  groundBase: {
    title: 'Base ground',
    text: 'Elevation of the ground the tripod is standing on, from the USGS heightmap. Mast height is added on top of this, so parking in a wash genuinely costs you.',
  },
  groundRover: {
    title: 'Rover ground',
    text: 'Elevation of the ground under the rover at its current position.',
  },
  riseToRover: {
    title: 'Rise to rover',
    text: 'How much higher or lower the rover’s ground is than the base’s. A rover far below you is often shadowed by the lip of the ground between you, whatever the straight-line distance says.',
  },
  worstClearance: {
    title: 'Worst clearance',
    text: 'The tightest point on the whole profile, as a percentage of the first Fresnel radius there. Below about 60% you are paying diffraction; below 0% the terrain is above the line of sight.',
  },
  pinchedAt: {
    title: 'Pinched at',
    text: 'How far along the path the worst clearance occurs. Useful for deciding whether the fix is moving the tripod or dropping a relay.',
  },
  roughness: {
    title: 'Ground roughness',
    text: 'RMS departure of the real ground from its own best-fit plane along this path, which sets how much of the specular reflection survives. Broken ground scatters the bounce away and is genuinely better than smooth ground for the two-ray null.',
  },
  offBoresight: {
    title: 'Off boresight',
    text: 'Angle between where the sector is aimed and where the rover is, computed from the map. This is what the base antenna’s azimuth pattern is being asked to cover.',
  },
  headingRow: {
    title: 'Heading and range',
    text: 'The rover’s compass bearing from the base and its distance, i.e. exactly where on the map the link is being solved.',
  },

  // ---------------------------------------------------------------- verdicts

  verdict: {
    title: 'The verdict',
    text: 'One line for whether the mission runs, in the order things actually fail: the link existing at all, then video plus control fitting in the airtime, then whether there is enough margin for either to stay true tomorrow.',
  },
  advice: {
    title: 'The tighter direction',
    text: 'Whichever direction has less link margin, and, the part that matters, whether money can help it. Gain on a transmitter already pinned at the Part 15 ceiling buys nothing; mast height, cable loss and channel width still do.',
  },

  // ----------------------------------------------------------- chart legends

  legendVideo: {
    title: 'Rover → base (video)',
    text: 'What the uplink would carry alone on the channel, against distance. This is the direction the cameras use and the one the base antenna’s receive gain helps, since receive gain is not capped by Part 15.',
  },
  legendControl: {
    title: 'Base → rover (control)',
    text: 'What the downlink would carry alone on the channel. It usually sits lower than the uplink despite the bigger transmitter, because the rover’s small omni is a poor receive antenna and the base is pinned at the EIRP ceiling.',
  },
  legendFloor: {
    title: 'Video floor',
    text: 'The 8 Mbps of H.265 the mission needs on the uplink. A reference level, not a cliff. Control only needs 0.5 Mbps, so the downlink crossing it means much less than the uplink doing so.',
  },
  legendDropout: {
    title: 'First video dropout',
    text: 'The nearest range at which the mission stops fitting. Everything left of it works; past it, look at the panels to see which of link, airtime or uptime gave out.',
  },
  legendNow: {
    title: 'Now',
    text: 'Where the distance slider currently sits, so you can read the chart against the panels beside it.',
  },
  legendLos: {
    title: 'Line of sight',
    text: 'The straight path between the two antennas. Its colour tracks the verdict: green if the mission fits, amber if it is marginal, red if the link is down.',
  },
  legendFresnel: {
    title: 'First Fresnel zone',
    text: 'The ellipse around the line of sight that needs to stay clear of terrain. Vertical scale on this view is heavily exaggerated, because 3 m of mast over 1 km of desert is invisible at true scale.',
  },
  legendBounce: {
    title: 'Ground bounce ray',
    text: 'The reflected ray a free-space budget forgets, and its reflection point. It arrives phase-flipped and nearly as strong as the direct ray, which is why the pair partly cancels.',
  },
  legendTerrain: {
    title: 'Terrain',
    text: 'The cut of ground under the path: the real heightmap profile on a map, or the synthetic ridge in the flat world.',
  },
  legendPinch: {
    title: 'Worst clearance',
    text: 'Where the terrain pinches the Fresnel zone hardest. This is the point the diffraction loss is being scored at.',
  },
  legendBeam: {
    title: 'Sector beam',
    text: 'The base antenna’s azimuth 3 dB beam, drawn to the rover’s range. Green while the rover is inside it, amber once it has wandered out.',
  },
  legendRover: {
    title: 'Rover bearing',
    text: 'Where the rover actually is relative to boresight. The gap between this and the middle of the wedge is the off-boresight loss.',
  },
  legendPattern: {
    title: 'Rover pattern',
    text: 'Elevation cut of the rover element’s pattern, rotated by the vehicle’s pitch. Gain falls to the sidelobe floor 20 dB below peak.',
  },
  legendToBase: {
    title: 'Direction to base',
    text: 'Where the base station sits from the rover’s point of view. How far this sits off the fat part of the pattern is what pitching on a slope costs you.',
  },

  // ------------------------------------------------------- the newer panels

  tornado: {
    title: 'What to fix first',
    text: 'Every lever on the page, re-solved one at a time, ranked by how much link margin it buys, measured on the tighter of the two directions, because that is the one that fails. The rows worth zero are the interesting ones: a lever can be dead because you are already at the Part 15 EIRP ceiling, because it only helps the direction that already has slack, or because this particular link simply is not limited by it. Each row says which.',
  },
  concurrent: {
    title: 'Both bands at once',
    text: 'The NetMetal ax runs 2.4 and 5 GHz simultaneously on the same diplexed pair, which is the whole reason for putting each on its own VLAN, because Babel has to see two links, not one. So the real question is not which band to use but which band carries which flow. Video wants the fastest band that clears 8 Mbps; control wants the one that is still there when the fast one has gone.',
  },
  trunk: {
    title: 'Both at once, down one cable',
    text: 'The radio has one Ethernet port, so both bands share it. Each band on its own is already held to what that port will pass, but they are sharing it rather than getting one each, so what matters is the total. Close in with both bands on their widest legal channel the air is worth more than a gigabit port will carry, and the wire becomes the limit. The 2.5G SFP is the way out.',
  },
  bandDiversity: {
    title: 'At least one band up',
    text: 'How much of the drive you have some link. The two numbers are an honest range rather than a hedge: the low one assumes both bands fade together, which is close to true for shadow fading over the same dirt, and the high one assumes they are independent. Diffraction genuinely differs per band, so the truth is above the floor, but believe the floor.',
  },
  cost: {
    title: 'What it costs',
    text: 'Radios and antennas only, per side, at the quantity the build actually needs, so the rover buys two omnis, not one. Cables, mast, PoE and the router are not in here. The dollars-per-dB figure is the one that makes the argument: past a certain point you are paying a great deal of money for margin you already had.',
  },
  compare: {
    title: 'A / B',
    text: 'Pin a build and it stops moving while you take the live bench apart, so “is the cheap panel good enough” becomes a column of differences rather than a memory test. Swap puts the pinned build back on the bench and pins what was there, so you can flip between two candidates. Green is better, red is worse, and cost knows that cheaper is better.',
  },
  coverage: {
    title: 'Coverage',
    text: 'The rover swept over every bearing and range around the base, shaded by how much of the drive the link holds up. This is the siting question, where can the rover go, which is a shape rather than a number, and it is the one the tripod position actually changes. Watch it while you drag the base station 20 m onto a rise.',
  },
};
