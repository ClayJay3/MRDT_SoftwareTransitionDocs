import React, {useMemo, useState} from 'react';
import styles from './LinkSim.module.css';

// Side-by-side of why we want Babel. Drag each band's packet loss and compare
// how EIGRP (loss-blind metric) and Babel (ETX) + the tc QoS layer hold up.
//
// The model is grounded in how the protocols actually work - see the "How this
// works" panel for the real mechanics and the exact simplifications - but it's
// a teaching tool, not a throughput predictor. SSR-safe: pure computation.

const BANDS0 = [
  {name: '900 MHz', cap: 6,   loss: 4, enabled: true,  role: 'long-range lifeline'},
  {name: '2.4 GHz', cap: 54,  loss: 2, enabled: true,  role: 'high-bandwidth workhorse'},
  {name: '5.8 GHz', cap: 100, loss: 0, enabled: false, role: 'shut down on the rover'},
];

// Offered demand, Mbps. Control (drive + telemetry) is tiny; video is big.
const CONTROL_DEMAND = 2;
const VIDEO_DEMAND = 40;
const OFFERED = CONTROL_DEMAND + VIDEO_DEMAND;

const SCENARIOS = {
  'All bands clear': [4, 2, 0],
  'Rover behind a hill (2.4 GHz degrading)': [10, 70, 0],
  '2.4 GHz dead, only 900 left': [12, 100, 0],
};

// Symmetric-loss ETX: a link delivering (1-p) each way needs ~1/(1-p)^2 tries.
const etxOf = (loss) => (loss >= 100 ? Infinity : 1 / Math.pow(1 - loss / 100, 2));
const pct = (x) => Math.max(0, Math.min(100, x * 100));

function compute(bands) {
  const up = bands.filter((b) => b.enabled && b.loss < 100);

  // ---- EIGRP: metric is bandwidth/delay only, so it's blind to loss. With
  // variance + maximum-paths it load-balances across feasible links, sharing
  // traffic by (configured) bandwidth. There's no QoS class separation, so a
  // saturated or lossy link drops control and video alike.
  let eigrp = {control: 0, video: 0, links: []};
  if (up.length) {
    const capSum = up.reduce((s, b) => s + b.cap, 0);
    let delivered = 0;
    const links = up.map((b) => {
      const offered = Math.min((b.cap / capSum) * OFFERED, b.cap); // can't exceed link cap
      const got = offered * (1 - b.loss / 100);
      delivered += got;
      return {name: b.name, share: b.cap / capSum};
    });
    const frac = delivered / OFFERED; // same fraction hits control and video
    eigrp = {control: frac, video: frac, links};
  }

  // ---- Babel: source-specific routing lets the control subnets and the camera
  // subnets be routed independently, each with its own tuned cost. Control is
  // latency-sensitive, so its table prefers the most reliable link (lowest ETX).
  // Video is bandwidth-hungry, so its table prefers the link with the most
  // deliverable throughput (capacity × delivery ratio). They ride the same link
  // when that link is best at both; when they share it, the tc prio qdisc serves
  // control first. Video only collapses when the fattest usable link is itself
  // tiny or gone (e.g. only 900 MHz left) — not just because control moved.
  let babel = {
    control: 0, video: 0,
    controlLink: null, controlEtx: Infinity,
    videoLink: null, videoThru: 0, sameLink: false,
  };
  if (up.length) {
    const controlLink = up.reduce((a, b) => (etxOf(b.loss) < etxOf(a.loss) ? b : a));
    const throughput = (b) => b.cap * (1 - b.loss / 100);
    const videoLink = up.reduce((a, b) => (throughput(b) > throughput(a) ? b : a));
    const same = controlLink.name === videoLink.name;

    const ctrlDeliv = Math.min(CONTROL_DEMAND, controlLink.cap) * (1 - controlLink.loss / 100);
    const vidCapAvail = videoLink.cap - (same ? CONTROL_DEMAND : 0); // share the link if it's the same one
    const vidDeliv = Math.min(VIDEO_DEMAND, Math.max(0, vidCapAvail)) * (1 - videoLink.loss / 100);

    babel = {
      control: ctrlDeliv / CONTROL_DEMAND,
      video: vidDeliv / VIDEO_DEMAND,
      controlLink: controlLink.name,
      controlEtx: etxOf(controlLink.loss),
      videoLink: videoLink.name,
      videoThru: throughput(videoLink),
      sameLink: same,
    };
  }
  return {eigrp, babel};
}

const verdict = (control) => {
  const c = control * 100;
  if (c >= 85) return {txt: '✅ joystick responsive', cls: 'ok'};
  if (c >= 60) return {txt: '⚠ control laggy', cls: 'warn'};
  if (c > 0) return {txt: '❌ joystick stalls - rover freezes', cls: 'bad'};
  return {txt: '❌ link down', cls: 'bad'};
};

const barCls = (v) => (v >= 0.85 ? styles.ok : v >= 0.6 ? styles.warn : styles.bad);

function Bar({label, value, demand}) {
  return (
    <div className={styles.barRow}>
      <span className={styles.barLbl}>{label}</span>
      <div className={styles.barTrack}>
        <div className={`${styles.barFill} ${barCls(value)}`} style={{width: `${pct(value)}%`}} />
      </div>
      <span className={styles.barPct}>{Math.round(pct(value))}%</span>
      <span className={styles.barMbps}>{(value * demand).toFixed(1)}/{demand}</span>
    </div>
  );
}

function InfoPanel() {
  return (
    <div className={styles.info}>
      <h5>How EIGRP actually routes</h5>
      <p>
        EIGRP picks paths by a <b>composite metric</b>. With the default K-values
        (<code>K1=K3=1</code>, <code>K2=K4=K5=0</code>) that metric is
        {' '}<code>256 × (10⁷ / min_bandwidth_kbps + cumulative_delay)</code> - <b>bandwidth and
        delay only</b>, and both are <i>static configured</i> values. EIGRP does measure each
        link’s <i>reliability</i> and <i>load</i>, but it does not put them in the metric unless you
        set <code>K4/K5</code>, which Cisco advises against because it makes routes oscillate. So a
        link sitting at 40% loss keeps the exact same metric and stays selected.
      </p>
      <p>
        DUAL installs the lowest-metric <i>successor</i> plus loop-free <i>feasible successors</i>;
        {' '}<code>maximum-paths</code> + <code>variance N</code> then do unequal-cost load
        balancing across feasible links (metric ≤ N × best), sharing traffic inversely to metric.
        Failure detection is the only place loss helps EIGRP: <b>BFD (hello 1 / hold 3)</b> drops a
        {' '}<i>fully dead</i> link sub-second - but an “up but lossy” link never trips it (and
        severe loss can make BFD flap, a problem of its own).
      </p>

      <h5>How Babel actually routes</h5>
      <p>
        Babel is built for lossy wireless. Each link’s cost comes from <b>ETX</b>, measured from the
        {' '}<b>Hello/IHU history</b>: a node tracks the fraction of recent Hellos it receives from a
        neighbor (forward delivery) and the neighbor reports back how well it hears you (reverse,
        via IHU). A cost of <code>256</code> means a perfect link (ETX 1.0 = one transmission); a
        link that needs ~2 tries costs ~512. The route metric is the <b>sum</b> of link costs along
        the path, kept loop-free by the feasibility condition + sequence numbers.
      </p>
      <p>
        Babel installs lowest-metric feasible routes and reacts with triggered updates, converging
        over a <i>few Hello intervals</i> (seconds), not milliseconds. The real win over EIGRP isn’t
        raw speed - it’s that it reacts to <b>partial packet loss at all</b>. One caveat: pure ETX is
        {' '}<b>throughput-blind</b> (it would prefer a clean slow link over a slightly-lossy fast
        one), so the bandwidth of each link has to be factored in too.
      </p>
      <p>
        The rover exploits <b>source-specific routing</b>: the control subnets
        (<code>192.168.2/3.x</code>) and the camera subnet (<code>192.168.4.x</code>) are routed
        from separate tables with different tuning. This sim models that intent — <b>control</b>
        follows the <i>most reliable</i> link (lowest ETX), since drive and telemetry are tiny and
        latency-sensitive, while <b>video</b> follows the link with the <i>most deliverable
        throughput</i> (capacity × delivery ratio). So when 2.4 GHz degrades, control hops to clean
        900 MHz while video stays on whatever fat link still moves the most bits — they don’t have to
        share a fate. When both classes do land on the same link, the tc prio qdisc below serves
        control first.
      </p>
      <p>
        Video only truly collapses when the fattest <i>usable</i> link is itself tiny — e.g. when
        2.4 GHz and 5.8 GHz are gone and only the 6 Mbps 900 MHz lifeline is left. That isn’t a
        glitch: a 6 Mbps pipe can’t carry 40 Mbps of camera feed, so the design spends the little
        bandwidth there is on keeping the rover driving and lets the video starve.
      </p>

      <h5>The QoS layer (this is what saves the joystick)</h5>
      <p>
        Independent of routing, a Linux <code>tc</code> <b>prio qdisc</b> on each Pi puts the control
        subnets (<code>192.168.2/3.x</code>) in the highest band and cameras
        (<code>192.168.4.x</code>) in the lowest. So on whatever link is in use, control packets
        transmit first and video is dropped first under congestion. That’s why, forced down onto
        slow 900 MHz, the rover still drives while the video starves.
      </p>

      <h5>What this sim simplifies</h5>
      <ul>
        <li>Loss is symmetric (forward = reverse); real ETX measures each direction separately.</li>
        <li>EIGRP’s split is modeled by configured bandwidth; the real share depends on the exact
          {' '}<code>bandwidth</code>/<code>delay</code> statements and the variance multiplier.</li>
        <li>One hop each way, instant convergence - no Hello-history warm-up, no flapping.</li>
        <li>UDP-style delivery (a lost packet is just gone); fixed control ≈ {CONTROL_DEMAND} Mbps and
          video ≈ {VIDEO_DEMAND} Mbps demand; capacities are representative, not measured.</li>
      </ul>
      <p className={styles.infoFoot}>
        Bottom line: the routing layer (loss-blind EIGRP vs loss-aware Babel) and the QoS layer
        (no class priority vs <code>tc prio</code>) are both real and both modeled here; the numbers
        are illustrative.
      </p>
    </div>
  );
}

export default function LinkSim() {
  const [bands, setBands] = useState(BANDS0);
  const [showInfo, setShowInfo] = useState(false);
  const {eigrp, babel} = useMemo(() => compute(bands), [bands]);

  const setLoss = (i, loss) => setBands((b) => b.map((x, j) => (j === i ? {...x, loss} : x)));
  const toggle = (i) => setBands((b) => b.map((x, j) => (j === i ? {...x, enabled: !x.enabled} : x)));
  const scenario = (losses) => setBands((b) => b.map((x, j) => ({...x, loss: losses[j]})));

  const ev = verdict(eigrp.control);
  const bv = verdict(babel.control);

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title}>Routing under packet loss</span>
        <button
          className={styles.infoBtn}
          aria-expanded={showInfo}
          onClick={() => setShowInfo((v) => !v)}
        >
          <span className={styles.infoMark}>i</span> How this works
        </button>
      </div>

      {showInfo && <InfoPanel />}

      <div className={styles.scenarios}>
        <span className={styles.scenLbl}>Try a scenario:</span>
        {Object.entries(SCENARIOS).map(([name, losses]) => (
          <button key={name} className={styles.scenBtn} onClick={() => scenario(losses)}>{name}</button>
        ))}
      </div>

      <div className={styles.bands}>
        {bands.map((b, i) => {
          const etx = etxOf(b.loss);
          return (
            <div key={b.name} className={`${styles.band} ${!b.enabled ? styles.bandOff : ''}`}>
              <div className={styles.bandHead}>
                <label className={styles.bandToggle}>
                  <input type="checkbox" checked={b.enabled} onChange={() => toggle(i)} />
                  <b>{b.name}</b>
                </label>
                <span className={styles.bandCap}>{b.cap} Mbps · {b.role}</span>
              </div>
              <label className={styles.lossCtl}>
                <span>packet loss <b>{b.loss}%</b></span>
                <input
                  type="range" min={0} max={100} value={b.loss}
                  disabled={!b.enabled}
                  onChange={(e) => setLoss(i, +e.target.value)}
                />
              </label>
              <div className={styles.etx}>
                ETX {etx === Infinity ? '∞ (down)' : etx.toFixed(2)}
                {b.enabled && b.loss < 100 && etx > 2 && <span className={styles.etxBad}> · bad link</span>}
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.compare}>
        <div className={styles.col}>
          <h4 className={styles.colHead}>EIGRP <small>(what we run today)</small></h4>
          <div className={styles.paths}>
            Using: {eigrp.links.length ? eigrp.links.map((l) => `${l.name} (${Math.round(l.share * 100)}%)`).join(' + ') : 'no links'}
            {' '}<em>- by bandwidth, blind to loss, no QoS</em>
          </div>
          <Bar label="🕹️ Control" value={eigrp.control} demand={CONTROL_DEMAND} />
          <Bar label="🎥 Video" value={eigrp.video} demand={VIDEO_DEMAND} />
          <div className={`${styles.verdict} ${styles[ev.cls]}`}>{ev.txt}</div>
        </div>

        <div className={styles.col}>
          <h4 className={styles.colHead}>Babel + tc QoS <small>(proposed)</small></h4>
          <div className={styles.paths}>
            {babel.controlLink ? (
              <>
                Control → <b>{babel.controlLink}</b> <em>(ETX {babel.controlEtx.toFixed(2)}, most reliable)</em>;
                {' '}Video → <b>{babel.videoLink}</b> <em>({Math.round(babel.videoThru)} Mbps usable, most throughput)</em>
                {babel.sameLink && <em> — same link, tc serves control first</em>}
              </>
            ) : 'no links'}
          </div>
          <Bar label="🕹️ Control" value={babel.control} demand={CONTROL_DEMAND} />
          <Bar label="🎥 Video" value={babel.video} demand={VIDEO_DEMAND} />
          <div className={`${styles.verdict} ${styles[bv.cls]}`}>{bv.txt}</div>
        </div>
      </div>

      <p className={styles.note}>
        Try the <b>“behind a hill”</b> scenario: EIGRP keeps load-balancing onto the half-dead 2.4 GHz
        link because it only sees “up,” so the joystick collapses right along with the video. Babel’s
        ETX for 2.4 GHz climbs, so it moves <i>control</i> onto clean 900 MHz while leaving <i>video</i>
        on the still-fattest link — the joystick stays responsive and only the cameras degrade. The
        bars show delivered ÷ offered Mbps; numbers are illustrative (see <a href="#qos-guaranteeing-the-joystick">QoS</a> and “How this works”).
      </p>
    </div>
  );
}
