/* ꙋ temtie · debug.js */
/** @import { DebugHub } from './types.d.ts' */

const listeners = new Set();

let disabled = false;
let seq = 0;

function noop() {}

function report(error) {
  try {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else globalThis.console?.error?.('temtie/debug: listener failed', error);
  } catch { /* reporting is best-effort */ }
}

/** @type {DebugHub} */
const debug = {
  enabled: false,
  stacks: false, // when true, stage and commit carry a captured stack
  cause: 0, // the enclosing span's seq: emit stamps it on events that carry none

  on(fn) {
    if (disabled) return noop;
    this.enabled = true;
    listeners.add(fn);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(fn);
      this.enabled = listeners.size > 0;
    };
  },

  // the production fuse: detach every observer and reject future ones for
  // this module instance. Deliberately irreversible.
  disable() {
    disabled = true;
    listeners.clear();
    this.enabled = false;
  },

  assert(condition, message, ev = {}) {
    if (condition) return;
    const error = new Error(message);
    ev.type ??= 'assert-failed';
    ev.error = error;
    this.emit(ev);
    throw error;
  },

  // the hub owns logical time: seq is the total order, cause the enclosing
  // span. physical time is the listener's to stamp on receipt — delivery
  // is synchronous, so a clock read there is the emit instant.
  emit(ev) {
    ev.seq = ++seq;
    ev.cause ??= this.cause;
    for (const fn of listeners) {
      try { fn(ev); }
      catch (error) { report(error); }
    }
    return ev;
  },

  // the stock timing listener: pairs cause-linked span events into
  // performance.measure entries, named by the caller — e.g.
  // debug.meter({ 'temtie:commit': ['commit', 'settled'] })
  meter(spans, perf = globalThis.performance) {
    this.assert(typeof perf?.now === 'function' && typeof perf?.measure === 'function',
      'debug.meter(): requires a perf with now() and measure()', { assert: 'debug.meter' });
    const starts = new Set(), ends = new Map();
    for (const [name, [start, end]] of Object.entries(spans)) {
      starts.add(start);
      ends.set(end, name);
    }
    const open = new Map();
    return this.on((ev) => {
      if (starts.has(ev.type)) {
        open.set(ev.seq, perf.now());
      } else if (ends.has(ev.type)) {
        const start = open.get(ev.cause);
        if (start === undefined) return;
        open.delete(ev.cause);
        perf.measure(ends.get(ev.type), { start, end: perf.now() });
      }
    });
  }
};

export default debug;
