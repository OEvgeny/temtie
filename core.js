/* ꙋ temtie · core.js */
/** @import { Mount, Capture, Commit, Skip, Reset } from './types.d.ts' */

import debug from './debug.js';

const PRIVATE = Symbol('temtie.private');
const UNSET = Symbol('temtie.unset');
const VALUE = Symbol.for('temtie.value');
const ROOT = 'root';

export const TEMPLATE_HOLE_TYPES = {
  CHILD: 'child',
  ATTR: 'attr',
  SPREAD: 'spread',
  META: 'meta',
};
const HOLE = TEMPLATE_HOLE_TYPES;

// one pass clock. a stamp from another target is not fresh.
let PASS = 0;

const IDLE = 'idle', STAGED = 'staged', SEALED = 'sealed';

/** @type {Mount} */
export function mount(container, { builders } = {}) {
  if (!container) throw new Error(`temtie/core: expected container, got ${String(container)}`);
  if (!builders || typeof builders !== 'object' || !Object.keys(builders).length)
    throw new Error('temtie/core: mount() requires builders, e.g. mount(el, { builders: { html } })');

  const ref = makeRef(makeTarget(makeProto(builders), { dest: DEST[ROOT], node: container }));
  debug.enabled && debug.emit({ type: 'mount', target: ref.target, container, builders: Object.keys(builders) });
  return ref.inst;
}

/** @type {Capture} */
export function capture() {
  return makeRef(null).inst;
}

/** @type {Commit} */
export function commit(inst) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError('temtie/core: commit() expects a target from mount() or capture()');
  if (ref.target) commitTarget(ref.target);
}

/** @type {Skip} */
export function skip(inst) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError('temtie/core: skip() expects a target from mount() or capture()');
  const target = ref.target;
  if (target?.state !== STAGED) return;
  voidOpened(target);
  call(target, 'skip');
  target.state = SEALED;
}

// close descendant passes that started after this one. a pass staged earlier stays open.
function voidOpened(target, since = target.pass) {
  for (const child of target.children) {
    voidOpened(child, since);
    if (child.state === STAGED && child.pass > since) child.voided = true;
  }
}

// stage an empty pass. committed segments stay until commit and can be reused before then.
/** @type {Reset} */
export function reset(inst) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError('temtie/core: reset() expects a target from mount() or capture()');
  const target = ref.target;
  if (!target) return;
  if (target.state === STAGED) voidOpened(target);
  call(target, 'reset');
}

// call is not paired. a pass may be replaced before it commits.
function call(target, via = 'render') {
  target.state = STAGED;
  target.pass = ++PASS;
  target.cursor = target.head;
  target.voided = false;
  debug.enabled && debug.emit({ type: 'call', target, pass: target.pass, via });
}

function makeProto(builders) {
  const proto = {};
  for (const [name, builder] of Object.entries(builders)) {
    if (typeof builder?.compile !== 'function')
      throw new TypeError(`temtie/core: builder "${name}" must have compile(strings)`);
    proto[name] = makeChannel(builder);
  }
  return proto;
}

function makeRef(target) {
  const ref = { inst: Object.create(target ? target.proto : null), target };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto, anchor) {
  const head = { prev: null, next: null };
  return {
    proto,
    anchor,
    parent: null,
    children: new Set(),
    // live segments are head..cursor. the tail is swept at flush.
    head,
    cursor: head,
    pass: 0,
    state: IDLE,
    unplaced: false,
    reordered: false,
    placedIn: null,
    voided: false, // do not append: a voided ancestor, or a commit that has taken this pass
    disposing: null, // bodies left to dispose after a throw
    buckets: new Map(),
  };
}

// cache by strings array, per builder. one compiled template must not merge two call sites.
const SITES = new WeakMap(); // builder → strings → { template }

function compile(builder, strings, target) {
  let cache = SITES.get(builder);
  if (!cache) SITES.set(builder, cache = new WeakMap());
  const cached = cache.get(strings);
  if (cached) return cached;

  const ev = debug.enabled && debug.emit({
    type: 'compile', builder, target, pass: target.pass,
    site: strings, html: strings.join('${...}').slice(0, 100),
  });
  const template = builder.compile(strings);
  if (!template?.fragment || !Array.isArray(template.holes))
    throw new TypeError('temtie/core: builder.compile() must return a template { fragment, holes, keySlot }');
  template.builder ??= builder;
  template.keySlot ??= -1;
  const site = { template };
  cache.set(strings, site);
  ev && debug.emit({ type: 'compiled', cause: ev.seq, template });
  return site;
}

function makeChannel(builder) {
  return function channel(strings, ...values) {
    const target = this[PRIVATE].target;
    touch(target);
    const site = compile(builder, strings, target),
      template = site.template,
      segment = takeSegment(target, site, values);
    const ev = debug.enabled && debug.emit({
      type: 'stage', target, pass: target.pass, segment, template,
      fresh: segment.pass === 0,
      key: template.keySlot >= 0 ? values[template.keySlot] : undefined,
      stack: debug.stacks ? new Error('stage') : undefined,
    });
    emit(target, segment);
    withCause(ev, () => resolveSegment(target, segment, values));
  };
}

function touch(target) {
  if (target.state === STAGED && !target.voided) return;
  if (target.state === SEALED) {
    target.state = STAGED;
    return;
  }
  // a pass started over closes the passes it opened
  if (target.state === STAGED) voidOpened(target);
  call(target);
}

// undefined, null, true, and false are not keys. 0, '', and NaN are.
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;

function takeSegment(target, site, values) {
  const template = site.template;
  let bucket = target.buckets.get(site);
  if (!bucket) target.buckets.set(site, bucket = { byIndex: [], byKey: new Map(), used: -1, pass: 0 });
  if (bucket.pass !== target.pass) {
    bucket.pass = target.pass;
    bucket.used = -1;
  }

  const key = template.keySlot >= 0 ? values[template.keySlot] : undefined;
  const keyed = carriesIdentity(key);
  let segment = keyed ? bucket.byKey.get(key) : bucket.byIndex[++bucket.used];
  if (!segment) {
    segment = makeSegment(site);
    if (keyed) bucket.byKey.set(key, segment);
    else bucket.byIndex[bucket.used] = segment;
  }
  debug.enabled && debug.assert(!keyed || segment.pass !== target.pass,
    'temtie/core: duplicate key in one pass', { assert: 'duplicate-key', target, key, segment });
  return segment;
}

function makeSegment(site) {
  const template = site.template,
    builder = template.builder,
    fragment = builder.clone(template.fragment);

  let start = builder.firstChild(fragment), end = builder.lastChild(fragment);
  if (!start) {
    const marker = builder.createMarker();
    builder.insert(fragment, marker);
    start = end = marker;
  }

  const bindings = template.holes.map((hole) => makeBinding(builder, fragment, hole));
  return { template, builder, start, end, bindings, values: [], prev: null, next: null, pass: 0, parked: null, sunk: false, clean: false };
}

// the child marker stays. content is the nodes after it.
function makeBinding(builder, fragment, hole) {
  const dest = DEST[hole.type],
    node = builder.resolve(fragment, hole.path);
  return {
    dest,
    slot: hole.slot,
    builder,
    marker: dest.kind === HOLE.CHILD ? node : null,
    node: dest.kind === HOLE.CHILD ? null : node,
    prop: hole.prop,
    name: hole.name ?? null,
    container: null,
    occupant: null,
    leavers: null,
    placedBody: null,
    handle: null,
    bag: dest.kind === HOLE.SPREAD ? {} : null,
  };
}

function emit(target, segment) {
  if (segment === target.cursor) return;
  segment.pass = target.pass;
  // one segment between the cursor and this one moves behind this one.
  const ahead = target.cursor.next;
  if (ahead && ahead !== segment && ahead.next === segment) {
    ahead.next = segment.next;
    if (segment.next) segment.next.prev = ahead;
    segment.prev = target.cursor;
    segment.next = ahead;
    ahead.prev = segment;
    target.cursor.next = segment;
    ahead.sunk = true;
    target.reordered = true;
  }
  if (target.cursor.next === segment) {
    target.cursor = segment;
    return;
  }
  if (segment.prev) {
    segment.prev.next = segment.next;
    if (segment.next) segment.next.prev = segment.prev;
  }
  const tail = target.cursor.next;
  segment.prev = target.cursor;
  segment.next = tail;
  if (tail) tail.prev = segment;
  target.cursor.next = segment;
  target.cursor = segment;
  target.reordered = true;
}

// no write: the value is not applied. no container: a body cannot anchor.
const DEST = {
  [ROOT]: {
    kind: ROOT,
    container: (anchor) => anchor.node,
    // insert the root marker after the container's existing children. if it is missing, lay it again.
    after(anchor, builder) {
      if (!anchor.marker || builder.parent(anchor.marker) !== anchor.node)
        anchor.marker = lay(anchor, builder);
      return anchor.marker;
    },
  },
  [HOLE.CHILD]: {
    kind: HOLE.CHILD,
    container: (binding) => binding.builder.parent(binding.marker),
    after: (binding) => binding.marker,
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      const occupant = binding.occupant;
      occupant.after = binding.builder.setChild(binding.marker, occupant.after, value);
    },
    clear(binding, occupant) {
      if (occupant.after)
        occupant.after = binding.builder.setChild(binding.marker, occupant.after, null);
    }
  },
  [HOLE.ATTR]: {
    kind: HOLE.ATTR,
    container: (binding) => binding.container ??= binding.builder.createRoot(),
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      binding.builder.setProp(binding.node, binding.prop, value);
    },
    // repeated deliver is the receiver's problem. core does not diff it.
    deliver(binding) {
      binding.builder.setProp(binding.node, binding.prop, binding.container ??= binding.builder.createRoot());
    }
  },
  [HOLE.META]: {
    kind: HOLE.META,
    instanceOnly: true,
    container: (binding) => binding.node,
  },
  [HOLE.SPREAD]: {
    kind: HOLE.SPREAD,
    alwaysWrite: true, // stored bag is the caller's object. mutating it and passing it again writes nothing
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      const next = value == null ? {} : Object(value);
      for (const name of Object.keys(binding.bag))
        if (!(name in next)) binding.builder.unsetProp(binding.node, name);
      for (const name of Object.keys(next))
        if (binding.bag[name] !== next[name]) binding.builder.setProp(binding.node, name, next[name]);
      binding.bag = next;
    }
  }
};

function lay(anchor, builder) {
  const marker = builder.createMarker();
  builder.insert(anchor.node, marker, null);
  return marker;
}

function resolveSegment(target, segment, values) {
  segment.values = values;
  let clean = true;
  for (const binding of segment.bindings) {
    const raw = values[binding.slot];
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      const init = raw[VALUE];
      if (init !== undefined) {
        clean = false;
        resolveInstance(target, binding, raw, init);
        continue;
      }
      if (raw[PRIVATE]) {
        clean = false;
        resolveBody(target, binding, raw[PRIVATE], values);
        continue;
      }
    }
    if (!holds(binding, raw)) {
      clean = false;
      resolvePlain(binding);
    }
  }
  segment.clean = clean;
}

function holds(binding, raw) {
  const occupant = binding.occupant;
  if (!occupant) return !binding.dest.write;
  return !binding.dest.alwaysWrite && occupant.kind === 'plain' && same(occupant.prev, raw);
}

function resolvePlain(binding) {
  if (binding.occupant?.kind === 'plain') return;
  displace(binding);
  if (!binding.dest.write) return;
  binding.occupant = { kind: 'plain', prev: UNSET, after: binding.marker };
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: binding.occupant });
}

// a fresh capture does not take a body that another value of the same call carries elsewhere.
const carried = (body, values) => values.some((value) => value?.[PRIVATE]?.target === body);

function resolveBody(parent, binding, ref, values) {
  // meta has no marker. a target cannot anchor there. an instance body can.
  if (binding.dest.instanceOnly)
    throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a target');

  const occupant = binding.occupant,
    child = ref.target
      ?? (occupant?.kind === 'body' && !carried(occupant.body, values) ? occupant.body : null)
      // a body displaced and not flushed is still committed. a fresh capture reuses it.
      ?? binding.leavers?.findLast((occ) => occ.kind === 'body' && !occ.body.anchor && !carried(occ.body, values))?.body
      ?? makeTarget(parent.proto, null);
  if (child.anchor?.dest.kind === ROOT)
    throw new Error('temtie/core: a mounted root cannot be interpolated into a template');
  if (ref.target !== child) {
    ref.target = child;
    Object.setPrototypeOf(ref.inst, child.proto);
  }
  if (occupant?.kind !== 'body' || occupant.body !== child) {
    displace(binding);
    binding.occupant = { kind: 'body', body: child };
    // taking this body back removes it from leavers. it is not ended.
    if (binding.leavers) binding.leavers = binding.leavers.filter((occ) => occ.body !== child);
    debug.enabled && debug.emit({ type: 'claim', binding, occupant: binding.occupant });
  }
  hook(parent, child, binding);
}

// [Symbol.for('temtie.value')]: init. init(inst, ...props) runs once per claim and returns hooks, or a render function.
// commit(handle) runs on each flush of the segment. release(handle) runs when the claim ends.
function resolveInstance(parent, binding, raw, init) {
  if (typeof init !== 'function')
    throw new TypeError('temtie/core: a contract value must carry an init function under Symbol.for("temtie.value")');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a contract');

  const props = raw.props ?? [];
  let occupant = binding.occupant;
  if (occupant?.kind !== 'instance' || occupant.init !== init) {
    // same init, pass not flushed: reuse the claim. do not call init again.
    const back = binding.leavers?.findLast((occ) => occ.kind === 'instance' && occ.init === init && !occ.released);
    displace(binding);
    const ref = back?.ref ?? makeRef(makeTarget(parent.proto, null));
    occupant = binding.occupant = back
      ?? { kind: 'instance', init, ref, body: ref.target, hooks: null, after: binding.marker };
    if (back) binding.leavers = binding.leavers.filter((occ) => occ !== back);
    debug.enabled && debug.emit({ type: 'claim', binding, occupant });
    hook(parent, occupant.body, binding);
    if (!back) {
      const made = init(ref.inst, ...props);
      occupant.hooks = typeof made === 'function' ? { render: made } : made ?? {};
    }
  } else {
    hook(parent, occupant.body, binding);
  }
  occupant.hooks.render?.(occupant.ref.inst, ...props);
}

function hook(parent, child, binding) {
  if (child.anchor === binding) return;
  for (let cursor = parent; cursor; cursor = cursor.parent)
    if (cursor === child)
      throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
  if (child.anchor) leave(child.anchor, child);
  child.parent?.children.delete(child);
  child.parent = parent;
  child.anchor = binding;
  child.unplaced = true;
  parent.children.add(child);
}

// drop a moved body occupant. displace a moved instance so release and clear run at flush. do not dispose the body.
function leave(binding, body) {
  if (binding.occupant?.body === body && binding.occupant.kind === 'instance') displace(binding);
  else if (binding.occupant?.body === body) binding.occupant = null;
  if (binding.leavers)
    binding.leavers = binding.leavers.filter((occupant) => occupant.kind === 'instance' || occupant.body !== body);
}

// record the occupant. do not change the medium. do not unhook a body already anchored at another hole.
function displace(binding) {
  const occupant = binding.occupant;
  if (!occupant) return;
  debug.enabled && debug.emit({ type: 'displace', binding, occupant });
  binding.occupant = null;
  (binding.leavers ??= []).push(occupant);
  const body = occupant.body;
  if (body && body.anchor === binding) {
    body.parent?.children.delete(body);
    body.parent = null;
    body.anchor = null;
    body.unplaced = false;
  }
}

function end(binding, occupant, sink) {
  debug.enabled && debug.emit({ type: 'end', binding, occupant });
  // release once per claim: a retry after a later step threw does not release again.
  if (occupant.kind === 'instance' && !occupant.released) {
    occupant.hooks.release?.(handleOf(binding));
    occupant.released = true;
  }
  binding.dest.clear?.(binding, occupant);
  if (occupant.body) endBody(occupant.body, sink);
}

function endBody(body, sink) {
  if (body.anchor) return; // still anchored: do not dispose
  evictChain(body.head.next);
  if (body.placedIn?.placedBody === body) body.placedIn.placedBody = null;
  body.placedIn = null;
  sink(body);
}

// extract a body last placed here once it is no longer anchored here, before this hole is rewritten or removed.
function extractPlaced(binding) {
  const body = binding.placedBody;
  if (!body || body.anchor === binding) return;
  binding.placedBody = null;
  if (body.placedIn === binding) body.placedIn = null;
  evictChain(body.head.next);
}

function notePlaced(target) {
  const binding = target.anchor;
  if (!binding || binding.dest.kind === ROOT) return;
  if (target.placedIn && target.placedIn !== binding && target.placedIn.placedBody === target) target.placedIn.placedBody = null;
  target.placedIn = binding;
  binding.placedBody = target;
}

function evictChain(segment) {
  for (; segment; segment = segment.next) park(segment);
}

function park(segment) {
  // extract a placed body that has left before extracting this range.
  for (const binding of segment.bindings) extractPlaced(binding);
  if (segment.builder.parent(segment.start))
    segment.parked = segment.builder.extract(segment.start, segment.end);
}

// end only at flush. a voided pass frees nothing.
// the list as taken. a throw keeps the front occupant. a push during end waits for the next flush.
function flushEnds(binding, sink = disposeTarget) {
  const leavers = binding.leavers;
  if (!leavers) return;
  const count = leavers.length;
  for (let index = 0; index < count; index++) {
    end(binding, leavers[0], sink);
    leavers.shift();
  }
  if (binding.leavers === leavers && !leavers.length) binding.leavers = null;
}

function sweepSegment(segment, sink) {
  for (const binding of segment.bindings) {
    extractPlaced(binding);
    displace(binding);
    flushEnds(binding, sink);
  }
}

// the queue stays on the target until it drains: a throw leaves the rest for the next flush.
function disposeTarget(target) {
  const queue = target.disposing ??= [target];
  const sink = (child) => { queue.push(child); };
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) continue;
    // adopt unfinished descendants before their owner is cleared or skipped.
    const pending = current.disposing;
    if (pending && pending !== queue) {
      for (const child of pending)
        if (child && child !== current) queue.push(child);
      current.disposing = null;
    }
    // hooked again since it was queued: it is live, its own flush ends what it left.
    if (current.anchor) {
      queue[index] = null;
      continue;
    }
    debug.enabled && debug.emit({ type: 'dispose', target: current });
    for (let segment = current.head.next; segment; segment = segment.next) sweepSegment(segment, sink);
    current.head.next = null;
    current.cursor = current.head;
    current.buckets.clear();
    current.children.clear();
    current.state = IDLE;
    current.unplaced = false;
    queue[index] = null;
  }
  target.disposing = null;
}

function pruneBuckets(target) {
  for (const [site, bucket] of target.buckets) {
    if (bucket.pass !== target.pass) {
      target.buckets.delete(site);
      continue;
    }
    if (bucket.byIndex.length > bucket.used + 1) bucket.byIndex.length = bucket.used + 1;
    for (const [key, segment] of bucket.byKey)
      if (segment.pass !== target.pass) bucket.byKey.delete(key);
  }
}

// flush staged targets, parents before children. one parent per target, so each target is visited once.
function commitTarget(target) {
  const root = debug.enabled && debug.emit({
    type: 'commit', target, pass: target.pass,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(root, () => {
    const queue = [target];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current.state === SEALED) {
        debug.enabled && debug.emit({ type: 'sealed', target: current, pass: current.pass });
        continue;
      }
      if (current.state === STAGED) {
        // taken: a render starts over, a commit retries. a flush that returns leaves it idle.
        current.voided = true;
        settle(current, 'flush', flushTarget);
      } else if (current.unplaced) settle(current, 'place', placeTarget);
      for (const child of current.children) queue.push(child);
    }

    debug.enabled && root && debug.emit({ type: 'settled', target });
  });
}

function settle(target, type, run) {
  const ev = debug.enabled && debug.emit({ type, target, pass: target.pass });
  withCause(ev, () => run(target));
}

function withCause(ev, run) {
  if (!ev) return run();
  const cause = debug.cause;
  debug.cause = ev.seq;
  try { return run(); }
  finally { debug.cause = cause; }
}

function placeTarget(target) {
  if (target.disposing) disposeTarget(target);
  extractPlaced(target.anchor);
  flushEnds(target.anchor);
  let prevEnd = null;
  for (let segment = target.head.next; segment; segment = segment.next) {
    place(target, segment, prevEnd);
    prevEnd = segment.end;
  }
  if (target.head.next) deliver(target);
  notePlaced(target);
  target.unplaced = false;
}

function flushTarget(target) {
  if (!target.anchor) throw new Error('temtie/core: cannot commit an unanchored capture');
  const pass = target.pass,
    boundary = target.cursor,
    reshaped = target.unplaced || target.reordered || boundary.next !== null;
  if (target.disposing) disposeTarget(target);
  // before a hook runs. a release can open another pass, and a later prune would drop sites that pass did not touch.
  if (reshaped) pruneBuckets(target);
  extractPlaced(target.anchor);
  flushEnds(target.anchor);

  // extract the tail and park sunk segments before placing. a segment left behind makes later placement tests fail.
  for (let segment = boundary.next; segment; segment = segment.next) {
    debug.enabled && debug.emit({ type: 'drop', target, segment });
    sweepSegment(segment, disposeTarget);
    if (segment.builder.parent(segment.start)) segment.builder.extract(segment.start, segment.end);
  }
  boundary.next = null;

  let prevEnd = null;
  if (reshaped)
    for (let segment = target.head.next; segment; segment = segment.next) {
      if (segment.sunk) {
        if (!inPlace(target, segment, prevEnd)) park(segment);
        segment.sunk = false;
      }
      prevEnd = segment.end;
    }

  // skip clean segments until one is placed. always place the first: the anchor marker may be missing.
  const first = target.head.next;
  let still = !reshaped;
  prevEnd = null;
  for (let segment = first; segment; segment = segment.next) {
    if (!still || segment === first || !segment.clean) {
      if (place(target, segment, prevEnd)) still = false;
      for (const binding of segment.bindings) flushBinding(binding, segment.values);
    }
    prevEnd = segment.end;
  }
  deliver(target);
  notePlaced(target);
  // only settle this pass. a callback may have recorded another one.
  if (target.pass !== pass) return;
  target.state = IDLE;
  target.unplaced = false;
  target.reordered = false;
}

function deliver(target) {
  const anchor = target.anchor;
  if (!anchor.dest.deliver) return;
  debug.enabled && debug.emit({ type: 'deliver', target, binding: anchor });
  anchor.dest.deliver(anchor);
}

function inPlace(target, segment, prevEnd) {
  const builder = segment.builder,
    anchor = target.anchor,
    after = prevEnd ?? anchor.dest.after?.(anchor, builder);
  return after
    ? builder.prev(segment.start) === after
    : builder.parent(segment.start) === anchor.dest.container(anchor);
}

function place(target, segment, prevEnd) {
  if (!segment.parked && inPlace(target, segment, prevEnd)) return false;

  const builder = segment.builder,
    anchor = target.anchor,
    after = prevEnd ?? anchor.dest.after?.(anchor, builder),
    container = anchor.dest.container(anchor);
  if (!segment.parked) {
    debug.enabled && debug.assert(builder.parent(segment.start),
      'temtie/core: cannot place a segment whose nodes left the medium',
      { assert: 'detached-start', target, segment, destination: container });
    segment.parked = builder.extract(segment.start, segment.end);
  }
  debug.enabled && debug.emit({ type: 'move', target, segment, container, after });
  builder.insert(container, segment.parked, after);
  segment.parked = null;
  return true;
}

// SameValueZero. NaN equals NaN.
const same = (a, b) => a === b || (a !== a && b !== b);

function flushBinding(binding, values) {
  extractPlaced(binding);
  flushEnds(binding);
  const occupant = binding.occupant;
  if (!occupant) return;
  if (occupant.kind === 'instance') occupant.hooks.commit?.(handleOf(binding));
  else if (occupant.kind === 'plain') {
    const value = values[binding.slot];
    if (binding.dest.alwaysWrite || !same(value, occupant.prev)) {
      binding.dest.write(binding, value);
      occupant.prev = value;
    }
  }
  // a body is flushed as its own target.
}

function handleOf(binding) {
  return binding.handle ??= makeHandle(binding);
}

// set() exists only where the destination writes. a meta handle has none.
function makeHandle(binding) {
  const dest = binding.dest,
    handle = {
      kind: dest.kind,
      builder: binding.builder,
      node: binding.node,
      marker: binding.marker,
      prop: binding.prop ?? null,
      name: binding.name,
    };
  if (dest.write) handle.set = (value) => dest.write(binding, value);
  return handle;
}
