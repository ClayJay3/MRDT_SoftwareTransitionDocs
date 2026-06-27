import React, {useState} from 'react';
import {STATES, TRANSITIONS, KIND_COLORS} from '@site/src/data/states';
import styles from './StateMachine.module.css';

// Click a state to see what it does, when it's entered, and how it exits.
// Driven from src/data/states.js so it stays in step with the reference.

export default function StateMachine() {
  const [sel, setSel] = useState('eNavigating');
  const cur = STATES.find((s) => s.id === sel);

  const outgoing = TRANSITIONS.filter(([f]) => f === sel);
  const incoming = TRANSITIONS.filter(([, t]) => t === sel);

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        Click a state. Blue = driving, yellow = approaching a target, green = verifying,
        red = recovery, grey = at rest.
      </div>

      <div className={styles.grid}>
        {STATES.map((s) => (
          <button
            key={s.id}
            className={`${styles.node} ${sel === s.id ? styles.sel : ''}`}
            style={{['--k']: KIND_COLORS[s.kind]}}
            onClick={() => setSel(s.id)}
          >
            {s.name}
          </button>
        ))}
      </div>

      <div className={styles.detail}>
        <h4>
          <span className={styles.dot} style={{background: KIND_COLORS[cur.kind]}} />
          {cur.name} <code className={styles.code}>{cur.id}</code>
        </h4>
        <p className={styles.blurb}>{cur.blurb}</p>
        <div className={styles.row}><span className={styles.k}>Entered when</span><span>{cur.enters}</span></div>
        <div className={styles.row}><span className={styles.k}>Leaves when</span><span>{cur.leaves}</span></div>

        <div className={styles.transWrap}>
          <div className={styles.transCol}>
            <div className={styles.transHead}>← comes from</div>
            {incoming.length ? incoming.map(([f, , trig], i) => (
              <button key={i} className={styles.trans} onClick={() => setSel(f)}>
                {STATES.find((s) => s.id === f).name} <em>({trig})</em>
              </button>
            )) : <div className={styles.none}>entry point</div>}
          </div>
          <div className={styles.transCol}>
            <div className={styles.transHead}>goes to →</div>
            {outgoing.length ? outgoing.map(([, t, trig], i) => (
              <button key={i} className={styles.trans} onClick={() => setSel(t)}>
                {STATES.find((s) => s.id === t).name} <em>({trig})</em>
              </button>
            )) : <div className={styles.none}>terminal</div>}
          </div>
        </div>

        {cur.consts.length > 0 && (
          <div className={styles.row}>
            <span className={styles.k}>Key constants</span>
            <span>{cur.consts.map((c) => <code key={c} className={styles.code}>{c}</code>)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
