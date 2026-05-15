/* ꙋ temtie · debug.js */
const listeners = new Set();

let defaultEnabled = false;

function noop () {}

const debug = {
  on(fn) {
    const hub = this;
    hub.enabled = true;
    listeners.add(fn);
    return function off () {
      listeners.delete(fn);
      if (!listeners.size) hub.enabled = defaultEnabled;
    }
  },
  enable() {
    this.assert(this.on === noop, 'debug.enable(): cannot be enabled once was disabled', { assert: 'debug.enable' });
    this.enabled = true;
    defaultEnabled = true;
  },
  disable() {
    this.clear();
    Object.assign(this, { on: noop, enabled: false })
  },
  assert(condition, message, ev = {}) {
    if (condition) return;
    const error = new Error(message);
    ev.type ??= 'assert-failed';
    ev.error = error;
    this.emit(ev);
    throw error;
  },
  emit(ev) {
    if (!('timestamp' in ev)) ev.timestamp = performance.now();
    for (const fn of listeners) fn(ev);
  },
  clear() {
    listeners.clear();
  }
};

export default Object.assign({ enabled: defaultEnabled }, debug);
