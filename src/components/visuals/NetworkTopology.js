import React, {useState} from 'react';
import {BOARDS, VLANS, RADIO_LINKS, SWITCHES, ROVECOMM} from '@site/src/data/network';
import styles from './NetworkTopology.module.css';

// An interactive, click-to-inspect map of the whole rover<->base network.
// Everything is driven from src/data/network.js so it can never drift from the
// reference tables. No external graph libs, keeps the build light and SSR-safe.

function vlanGroups(side) {
  // side: 'rover' (vlans 2,3,4) or 'base' (vlan 100)
  const vlans = side === 'rover' ? [2, 3, 4] : [100];
  return vlans.map((v) => ({
    vlan: v,
    meta: VLANS[v],
    boards: BOARDS.filter((b) => b.vlan === v),
  }));
}

export default function NetworkTopology() {
  const [sel, setSel] = useState(null);

  const select = (kind, payload) => setSel({kind, payload});

  const Chip = ({board}) => (
    <button
      className={`${styles.chip} ${board.highlight ? styles.chipHi : ''} ${
        sel?.kind === 'board' && sel.payload.name === board.name ? styles.chipSel : ''
      }`}
      style={{borderColor: VLANS[board.vlan].color}}
      onClick={() => select('board', board)}
    >
      {board.name}
    </button>
  );

  const VlanCard = ({group}) => (
    <div className={styles.vlanCard} style={{['--vlan-color']: group.meta.color}}>
      <div className={styles.vlanHead}>
        <span className={styles.vlanTag}>VLAN {group.vlan}</span>
        <span className={styles.vlanName}>{group.meta.name}</span>
      </div>
      <div className={styles.vlanSubnet}>{group.meta.subnet}</div>
      <div className={styles.chipWrap}>
        {group.boards.map((b) => (
          <Chip key={b.name} board={b} />
        ))}
      </div>
    </div>
  );

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        Click anything, a board, a switch, or a radio band, to inspect it. RoveComm
        rides UDP {ROVECOMM.udpPort} / TCP {ROVECOMM.tcpPort} over all of this.
      </div>

      <div className={styles.grid}>
        {/* ROVER SIDE */}
        <div className={styles.side}>
          <div className={styles.sideLabel}>🤖 ROVER</div>
          {vlanGroups('rover').map((g) => (
            <VlanCard key={g.vlan} group={g} />
          ))}
          <button
            className={`${styles.switch} ${sel?.kind === 'switch' && sel.payload === 'rover' ? styles.switchSel : ''}`}
            onClick={() => select('switch', 'rover')}
          >
            🗄️ Rover Switch
            <small>{SWITCHES.rover.hostname}</small>
          </button>
        </div>

        {/* WIRELESS GAP */}
        <div className={styles.gap}>
          <div className={styles.gapLabel}>～ wireless gap ～</div>
          {RADIO_LINKS.map((r) => (
            <button
              key={r.band}
              className={`${styles.radio} ${r.active ? styles.radioOn : styles.radioOff} ${
                sel?.kind === 'radio' && sel.payload.band === r.band ? styles.radioSel : ''
              }`}
              onClick={() => select('radio', r)}
            >
              <span className={styles.radioDot}>{r.active ? '🟢' : '⛔'}</span>
              {r.band}
              <small>{r.subnet}</small>
            </button>
          ))}
        </div>

        {/* BASE SIDE */}
        <div className={styles.side}>
          <div className={styles.sideLabel}>🛰️ BASESTATION</div>
          <button
            className={`${styles.switch} ${sel?.kind === 'switch' && sel.payload === 'base' ? styles.switchSel : ''}`}
            onClick={() => select('switch', 'base')}
          >
            🗄️ Base Switch
            <small>{SWITCHES.base.hostname}</small>
          </button>
          {vlanGroups('base').map((g) => (
            <VlanCard key={g.vlan} group={g} />
          ))}
        </div>
      </div>

      {/* DETAIL PANEL */}
      <div className={styles.detail}>
        {!sel && <em>Nothing selected. Click a node above.</em>}

        {sel?.kind === 'board' && (
          <>
            <h4>{sel.payload.name} <span className={styles.muted}>· RoveComm board</span></h4>
            <table className={styles.kv}>
              <tbody>
                <tr><td>IP</td><td><code>{sel.payload.ip}</code></td></tr>
                <tr><td>VLAN</td><td>{sel.payload.vlan}, {VLANS[sel.payload.vlan].name} ({VLANS[sel.payload.vlan].subnet})</td></tr>
                <tr><td>Role</td><td>{sel.payload.role}</td></tr>
                <tr><td>Packets</td><td>{sel.payload.cmds} commands · {sel.payload.tlm} telemetry · {sel.payload.err} error</td></tr>
                <tr><td>Gateway</td><td><code>{VLANS[sel.payload.vlan].gateway}</code> (switch SVI)</td></tr>
              </tbody>
            </table>
          </>
        )}

        {sel?.kind === 'switch' && (() => {
          const s = SWITCHES[sel.payload];
          return (
            <>
              <h4>{s.hostname} <span className={styles.muted}>· Cisco switch</span></h4>
              <table className={styles.kv}>
                <tbody>
                  <tr><td>Model</td><td>{s.model}</td></tr>
                  <tr><td>IOS</td><td>{s.ios}</td></tr>
                  <tr><td>Loopback0 / Mgmt</td><td><code>{s.loopback}</code></td></tr>
                  <tr><td>VTP domain</td><td>{s.vtp} (transparent)</td></tr>
                  <tr><td>Routing</td><td>EIGRP AS {s.eigrpAS}{s.eigrpStub ? ' (stub)' : ''}</td></tr>
                  {s.isRP && <tr><td>Multicast</td><td>PIM Rendezvous Point for the whole network</td></tr>}
                </tbody>
              </table>
            </>
          );
        })()}

        {sel?.kind === 'radio' && (
          <>
            <h4>{sel.payload.band} link <span className={styles.muted}>· {sel.payload.active ? 'ACTIVE' : 'SHUT DOWN'}</span></h4>
            <table className={styles.kv}>
              <tbody>
                <tr><td>Subnet</td><td><code>{sel.payload.subnet}</code></td></tr>
                <tr><td>Rover switch IF</td><td><code>{sel.payload.roverSwIf}</code></td></tr>
                <tr><td>Base switch IF</td><td><code>{sel.payload.baseSwIf}</code></td></tr>
                <tr><td>Rover rocket</td><td><code>{sel.payload.roverRocket}</code></td></tr>
                <tr><td>Base rocket</td><td><code>{sel.payload.baseRocket}</code></td></tr>
                <tr><td>Notes</td><td>{sel.payload.note}</td></tr>
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
