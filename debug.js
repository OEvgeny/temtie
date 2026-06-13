/* ꙋ temtie · debug.js */
/** @import { DebugHub } from './types.d.ts' */

const listeners = new Set();

let defaultEnabled = false;
let seq = 0;

function noop() {}

/** @type {DebugHub} */
const debug = {
  enabled: defaultEnabled,
  stacks: false, // when true, span events carry a captured stack
  cause: 0, // the enclosing span's seq: emit stamps it on events that carry none

  on(fn) {
    const hub = this;
    hub.enabled = true;
    listeners.add(fn);
    return function off() {
      listeners.delete(fn);
      if (!listeners.size) hub.enabled = defaultEnabled;
    };
  },

  enable() {
    this.assert(this.on !== noop, 'debug.enable(): cannot be enabled once was disabled', { assert: 'debug.enable' });
    this.enabled = true;
    defaultEnabled = true;
  },

  disable() {
    this.clear();
    Object.assign(this, { on: noop, enabled: false });
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
    for (const fn of listeners) fn(ev);
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
  },

  clear() {
    listeners.clear();
  },
};

export default debug;
