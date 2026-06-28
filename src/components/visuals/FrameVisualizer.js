import React, {useState} from 'react';
import styles from './FrameVisualizer.module.css';

// Top-down visualizer for the camera → rover → world(UTM) transform that
// GeolocateBox performs. Drag the rover heading and the detection's position in
// the camera frame, and watch the resulting global UTM coordinate update.
// World frame is NWU (north up, west left), heading is clockwise from north,
// matching the conventions on the Autonomy page. SSR-safe: pure SVG + state.

// Example rover position in UTM (zone 12S, near MDRS). Arbitrary but realistic.
const E0 = 518200;
const N0 = 4250300;

const W = 360;
const H = 300;
const CX = W / 2;
const CY = H / 2 + 10;
const SCALE = 5; // px per meter

const rad = (deg) => (deg * Math.PI) / 180;

export default function FrameVisualizer() {
  const [heading, setHeading] = useState(40); // deg, clockwise from north
  const [fwd, setFwd] = useState(12);         // camera +Z, meters forward
  const [right, setRight] = useState(4);      // camera +X, meters right

  const th = rad(heading);
  // Camera/rover frame → world NWU offset (the rotate-by-heading step).
  const n = fwd * Math.cos(th) - right * Math.sin(th);   // north
  const w = -fwd * Math.sin(th) - right * Math.cos(th);  // west
  // World NWU offset → UTM (the translate-by-rover-position step).
  const easting = E0 - w;
  const northing = N0 + n;

  // Object drawn inside the rotated rover group: local up = forward, right = +x.
  const objLocalX = right * SCALE;
  const objLocalY = -fwd * SCALE;
  const L = 46; // axis arrow length

  return (
    <div className={styles.root}>
      <div className={styles.layout}>
        <svg viewBox={`0 0 ${W} ${H}`} className={styles.svg} role="img" aria-label="Top-down coordinate frame view">
          {/* world grid */}
          {[...Array(9)].map((_, i) => (
            <line key={`v${i}`} x1={i * 45} y1={0} x2={i * 45} y2={H} className={styles.grid} />
          ))}
          {[...Array(7)].map((_, i) => (
            <line key={`h${i}`} x1={0} y1={i * 50} x2={W} y2={i * 50} className={styles.grid} />
          ))}

          {/* world compass: N up, W left (the positive NWU axes) */}
          <g className={styles.worldAxis}>
            <line x1={CX} y1={CY} x2={CX} y2={CY - 120} />
            <line x1={CX} y1={CY} x2={CX - 150} y2={CY} />
            <text x={CX + 6} y={CY - 110}>+X north</text>
            <text x={CX - 148} y={CY - 8}>+Y west</text>
          </g>

          {/* detection ray + object + rover, all rotated by heading */}
          <g transform={`rotate(${heading} ${CX} ${CY})`}>
            {/* camera FOV cone (forward, ±35°) */}
            <path
              d={`M ${CX} ${CY}
                  L ${CX + Math.tan(rad(35)) * 130} ${CY - 130}
                  L ${CX - Math.tan(rad(35)) * 130} ${CY - 130} Z`}
              className={styles.fov}
            />
            {/* rover-frame axes: forward (up) + left */}
            <line x1={CX} y1={CY} x2={CX} y2={CY - L} className={styles.fwdAxis} markerEnd="url(#fwdArrow)" />
            <line x1={CX} y1={CY} x2={CX - L} y2={CY} className={styles.leftAxis} markerEnd="url(#leftArrow)" />
            <text x={CX + 5} y={CY - L + 4} className={styles.axisLbl}>+X fwd</text>
            <text x={CX - L} y={CY - 6} className={styles.axisLbl}>+Y left</text>

            {/* detection ray */}
            <line x1={CX} y1={CY} x2={CX + objLocalX} y2={CY + objLocalY} className={styles.ray} />
            {/* the rover */}
            <rect x={CX - 9} y={CY - 6} width={18} height={12} rx={2} className={styles.rover} />
            {/* the detected object */}
            <circle cx={CX + objLocalX} cy={CY + objLocalY} r={6} className={styles.obj} />
          </g>

          <defs>
            <marker id="fwdArrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className={styles.fwdFill} />
            </marker>
            <marker id="leftArrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className={styles.leftFill} />
            </marker>
          </defs>
        </svg>

        <div className={styles.panel}>
          <label className={styles.slider}>
            <span>Rover heading <b>{heading}°</b> <small>(CW from north)</small></span>
            <input type="range" min={0} max={359} value={heading} onChange={(e) => setHeading(+e.target.value)} />
          </label>
          <label className={styles.slider}>
            <span>Detection forward (camera +Z) <b>{fwd} m</b></span>
            <input type="range" min={0} max={22} value={fwd} onChange={(e) => setFwd(+e.target.value)} />
          </label>
          <label className={styles.slider}>
            <span>Detection right (camera +X) <b>{right} m</b></span>
            <input type="range" min={-12} max={12} value={right} onChange={(e) => setRight(+e.target.value)} />
          </label>

          <div className={styles.readout}>
            <div className={styles.step}>
              <span className={styles.stepK}>Camera frame</span>
              forward {fwd} m, right {right} m
            </div>
            <div className={styles.arrow}>↓ rotate by heading ({heading}°)</div>
            <div className={styles.step}>
              <span className={styles.stepK}>World offset (NWU)</span>
              {n.toFixed(1)} m north, {Math.abs(w).toFixed(1)} m {w >= 0 ? 'west' : 'east'}
            </div>
            <div className={styles.arrow}>↓ translate by rover UTM</div>
            <div className={`${styles.step} ${styles.result}`}>
              <span className={styles.stepK}>World UTM</span>
              E <code>{easting.toFixed(1)}</code> · N <code>{northing.toFixed(1)}</code>
            </div>
          </div>
        </div>
      </div>
      <p className={styles.note}>
        This is exactly what <code>GeolocateBox</code> does: take a detection’s (X, Y, Z) in the
        ZED’s camera frame, rotate it by the rover’s heading, and translate it by the rover’s UTM
        position to get a global coordinate the state machine can drive to. Rover UTM here is a
        fixed example (<code>{E0}, {N0}</code>); only the offset changes as you drag.
      </p>
    </div>
  );
}
