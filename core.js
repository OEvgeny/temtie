/* ꙋ temtie · core.js */
/** @import { Mount, Capture, Commit, Skip, Reset } from './types.d.ts' */

import debug from './debug.js';

const PRIVATE = Symbol('temtie.private');
const UNSET = Symbol('temtie.unset');
const VALUE = Symbol.for('temtie.value');
const ROOT = 'root';

// the hole kinds are the shared vocabulary between the parser (which emits
// them) and DEST (which answers for them). they live here because what a
// hole *is* belongs to the core; how one is spelled is the builder's job.
export const TEMPLATE_HOLE_TYPES = {
  CHILD: 'child',
  ATTR: 'attr',
  SPREAD: 'spread',
  META: 'meta',
};
const HOLE = TEMPLATE_HOLE_TYPES;

// one clock for all targets: a stale structure can never masquerade as
// fresh by crossing targets
let PASS = 0;

const IDLE = 'idle', STAGED = 'staged', SEALED = 'sealed';

// the core turns on two axes. a destination is how a hole reaches the
// medium; an occupant is what holds it — a plain value, a body (a target
// named by a ref), or a contract instance with a body of its own. a ref
// carrying a target lends it to the hole; an empty ref inherits the hole's
// target. one disposal law covers every occupant: what a commit does not
// restage leaves the medium. disposal reaches bodies, not names — a name
// interpolated again grows a fresh body.

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

// skip() seals the target. commit then treats the seal as a wall — no
// flush, no descent — so nothing the voided pass staged can surface; the
// committed output stands and stays borrowable until a render reopens it.
/** @type {Skip} */
export function skip(inst) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError('temtie/core: skip() expects a target from mount() or capture()');
  const target = ref.target;
  if (target?.state !== STAGED) return;
  call(target, 'skip');
  target.state = SEALED;
}

// reset() stages emptiness, not destruction: the committed segments stay
// borrowable, so a render before the next commit can rebuild over them.
/** @type {Reset} */
export function reset(inst) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError('temtie/core: reset() expects a target from mount() or capture()');
  const target = ref.target;
  if (!target) return;
  call(target, 'reset');
}

// 'call' is a point event, never paired: a pass may be re-staged into the
// next before it ever commits, so nothing ever closes it.
function call(target, via = 'render') {
  target.state = STAGED;
  target.pass = ++PASS;
  target.cursor = target.head;
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
    // one chain, one cursor: live content is head..cursor in emission
    // order, everything past the cursor awaits the flush sweep
    head,
    cursor: head,
    pass: 0,
    state: IDLE,
    moved: false, // orthogonal: an idle target can still need placement
    buckets: new Map(),
  };
}

// compiling is the builder's; site identity is the core's. the cache holds a
// record per strings array so a compiler may share one compiled template
// without collapsing separate call sites into one segment bucket.
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
    // the pass opens before the template compiles: an ad-hoc compile is a
    // cost of the pass that first touched the site, and the event says so
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
  if (target.state === STAGED) return;
  if (target.state === SEALED) {
    target.state = STAGED;
    return;
  }
  call(target);
}

function takeSegment(target, site, values) {
  const template = site.template;
  let bucket = target.buckets.get(site);
  if (!bucket) target.buckets.set(site, bucket = { byIndex: [], byKey: new Map(), used: -1, pass: 0 });
  if (bucket.pass !== target.pass) {
    bucket.pass = target.pass;
    bucket.used = -1;
  }

  const key = template.keySlot >= 0 ? values[template.keySlot] : undefined;
  let segment = key !== undefined ? bucket.byKey.get(key) : bucket.byIndex[++bucket.used];
  if (!segment) {
    segment = makeSegment(site);
    if (key !== undefined) bucket.byKey.set(key, segment);
    else bucket.byIndex[bucket.used] = segment;
  }
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
  return { template, builder, start, end, bindings, values: [], prev: null, next: null, pass: 0 };
}

// a child marker never moves and never leaves: content lives after it
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
    handle: null,
    bag: dest.kind === HOLE.SPREAD ? {} : null,
  };
}

// splices the segment in after the cursor, preserving the borrowable tail
function emit(target, segment) {
  if (segment === target.cursor) return;
  segment.pass = target.pass;
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
}

// a destination answers for its hole kind: where a hosted body lives
// (container/after), how a value reaches the medium (write), how a body is
// handed over (deliver). the capabilities are the law: no write — a value
// never reaches the medium; no container — nothing can anchor there.
const DEST = {
  [ROOT]: {
    kind: ROOT,
    container: (anchor) => anchor.node,
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
    // handover, never reconciliation: the receiver decides what a
    // re-assignment means
    deliver(binding) {
      binding.builder.setProp(binding.node, binding.prop, binding.container);
    }
  },
  [HOLE.META]: {
    kind: HOLE.META,
    closed: true, // takes no target from the outside, only an instance body
    container: (binding) => binding.node,
  },
  [HOLE.SPREAD]: {
    kind: HOLE.SPREAD,
    eager: true, // re-diffs every flush: the bag may be the same object mutated
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

function resolveSegment(target, segment, values) {
  segment.values = values;
  for (const binding of segment.bindings) {
    const raw = values[binding.slot],
      init = raw?.[VALUE];
    if (init !== undefined) resolveInstance(target, binding, raw, init);
    else if (raw?.[PRIVATE]) resolveBody(target, binding, raw[PRIVATE]);
    else resolvePlain(binding);
  }
}

function resolvePlain(binding) {
  if (binding.occupant?.kind === 'plain') return;
  displace(binding);
  if (!binding.dest.write) return;
  binding.occupant = { kind: 'plain', prev: UNSET, after: binding.marker };
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: binding.occupant });
}

function resolveBody(parent, binding, ref) {
  // a closed hole has no marker, so its content has no defined placement —
  // but an instance body may still anchor there (resolveInstance does)
  if (binding.dest.closed)
    throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a target');

  const occupant = binding.occupant,
    child = ref.target
      ?? (occupant?.kind === 'body' ? occupant.body : null)
      ?? makeTarget(parent.proto, null);
  if (child.anchor?.dest.kind === ROOT)
    throw new Error('temtie/core: a mounted root cannot be interpolated into a template');
  if (child === parent)
    throw new Error('temtie/core: a target cannot be interpolated into itself');

  if (ref.target !== child) {
    ref.target = child;
    Object.setPrototypeOf(ref.inst, child.proto);
  }
  if (occupant?.kind !== 'body' || occupant.body !== child) {
    displace(binding);
    binding.occupant = { kind: 'body', body: child };
    debug.enabled && debug.emit({ type: 'claim', binding, occupant: binding.occupant });
  }
  hook(parent, child, binding);
}

// the VALUE contract: { [Symbol.for('temtie.value')]: init, props }. init
// runs once per claim, its closure is the instance state, and it returns
// the hooks (a bare function reads as { render }). render(t) goes through
// the supplied body, so render-phase work is DOM-pure by construction.
// commit(handle) runs at every flush of the owning segment; release(handle)
// fires when the claim ends — displaced, or disposed with its segment.
function resolveInstance(parent, binding, raw, init) {
  if (typeof init !== 'function')
    throw new TypeError('temtie/core: a contract value must carry an init function under Symbol.for("temtie.value")');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a contract');

  const props = raw.props ?? [];
  let occupant = binding.occupant;
  if (occupant?.kind !== 'instance' || occupant.init !== init) {
    displace(binding);
    const ref = makeRef(makeTarget(parent.proto, null));
    occupant = binding.occupant = { kind: 'instance', init, ref, body: ref.target, hooks: null, after: binding.marker };
    debug.enabled && debug.emit({ type: 'claim', binding, occupant });
    hook(parent, occupant.body, binding);
    const made = init(ref.inst, ...props);
    occupant.hooks = typeof made === 'function' ? { render: made } : made ?? {};
  } else {
    hook(parent, occupant.body, binding); // the body follows its binding every pass
  }
  occupant.hooks.render?.(occupant.ref.inst, ...props);
}

function hook(parent, child, binding) {
  if (child.anchor === binding) return;
  child.parent?.children.delete(child);
  child.parent = parent;
  child.anchor = binding;
  child.moved = true;
  parent.children.add(child);
}

// displacing is bookkeeping: the DOM stays put until the ends fire at
// flush. a leaver another hole already claimed this pass keeps that claim
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
    body.moved = false;
  }
}

function end(binding, occupant, sink) {
  debug.enabled && debug.emit({ type: 'end', binding, occupant });
  if (occupant.kind === 'instance') occupant.hooks.release?.(handleOf(binding));
  binding.dest.clear?.(binding, occupant);
  if (occupant.body) endBody(occupant.body, sink);
}

function endBody(body, sink) {
  // re-anchored: evict only while the move is pending — its DOM
  // legitimately lives elsewhere otherwise
  if (body.anchor) {
    if (body.moved) evictChain(body.head.next);
    return;
  }
  evictChain(body.head.next);
  sink(body);
}

function evictChain(segment) {
  for (; segment; segment = segment.next)
    if (segment.builder.parent(segment.start)) segment.builder.extract(segment.start, segment.end);
}

// ends fire only at flush: a voided pass frees nothing
function flushEnds(binding, sink = disposeTarget) {
  if (!binding.leavers) return;
  const batch = binding.leavers;
  binding.leavers = null;
  for (const occupant of batch) end(binding, occupant, sink);
}

// a disposed segment's standing occupant is displaced like any other leaver
function sweepSegment(segment, sink) {
  for (const binding of segment.bindings) {
    displace(binding);
    flushEnds(binding, sink);
  }
}

// a disposed target is left empty but valid: its ref renders again from scratch
function disposeTarget(target) {
  const queue = [target], seen = new Set(queue);
  const sink = (child) => { if (!seen.has(child)) seen.add(child), queue.push(child); };
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    debug.enabled && debug.emit({ type: 'dispose', target: current });
    for (let segment = current.head.next; segment; segment = segment.next) sweepSegment(segment, sink);
    current.head.next = null;
    current.cursor = current.head;
    current.buckets.clear();
    current.children.clear();
    current.state = IDLE;
    current.moved = false;
  }
}

// a segment not borrowed this pass is dropped at flush; its bucket entry
// goes too, matched by the same pass stamp
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

// flush only what was staged, parents before children; the queue keeps deep
// trees off the call stack, the seen set keeps cycles to one visit
function commitTarget(target) {
  const root = debug.enabled && debug.emit({
    type: 'commit', target, pass: target.pass,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(root, () => {
    const queue = [target], seen = new Set(queue);
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      if (current.state === SEALED) { // the wall: no flush, no descent
        debug.enabled && debug.emit({ type: 'sealed', target: current, pass: current.pass });
        continue;
      }
      if (current.state === STAGED) settle(current, 'flush', flushTarget);
      else if (current.moved) settle(current, 'place', placeTarget);
      for (const child of current.children)
        if (!seen.has(child)) seen.add(child), queue.push(child);
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

// an idle body whose anchor moved is placed, not re-rendered
function placeTarget(target) {
  target.moved = false;
  flushEnds(target.anchor);
  let prevEnd = null;
  for (let segment = target.head.next; segment; segment = segment.next) {
    place(target, segment, prevEnd);
    prevEnd = segment.end;
  }
  if (target.head.next) deliver(target); // an empty body delivers nothing
}

function flushTarget(target) {
  if (!target.anchor) throw new Error('temtie/core: cannot commit an unanchored capture');
  target.state = IDLE;
  target.moved = false;
  flushEnds(target.anchor);

  const boundary = target.cursor;
  if (boundary !== target.head) {
    let prevEnd = null;
    for (let segment = target.head.next; ; segment = segment.next) {
      place(target, segment, prevEnd);
      for (const binding of segment.bindings) flushBinding(binding, segment.values);
      prevEnd = segment.end;
      if (segment === boundary) break;
    }
  }

  for (let segment = boundary.next; segment; segment = segment.next) {
    debug.enabled && debug.emit({ type: 'drop', target, segment });
    if (segment.builder.parent(segment.start)) segment.builder.extract(segment.start, segment.end);
    sweepSegment(segment, disposeTarget);
  }
  boundary.next = null;
  pruneBuckets(target);
  deliver(target);
}

function deliver(target) {
  const anchor = target.anchor;
  if (!anchor.dest.deliver) return;
  debug.enabled && debug.emit({ type: 'deliver', target, binding: anchor });
  anchor.dest.deliver(anchor);
}

function place(target, segment, prevEnd) {
  const builder = segment.builder,
    anchor = target.anchor,
    container = anchor.dest.container(anchor),
    after = prevEnd ?? anchor.dest.after?.(anchor);

  if (
    builder.parent(segment.start) === container &&
    (!after || builder.prev(segment.start) === after)
  ) return;

  debug.enabled && debug.emit({ type: 'move', target, segment, container, after: after ?? null });
  const content = builder.extract(segment.start, segment.end);
  builder.insert(container, content, after ? builder.next(after) : null);
}

function flushBinding(binding, values) {
  flushEnds(binding);
  const occupant = binding.occupant;
  if (!occupant) return;
  if (occupant.kind === 'instance') occupant.hooks.commit?.(handleOf(binding));
  else if (occupant.kind === 'plain') {
    const value = values[binding.slot];
    if (binding.dest.eager || value !== occupant.prev) {
      binding.dest.write(binding, value);
      occupant.prev = value;
    }
  }
  // a body flushes itself: it is a target in the commit walk
}

function handleOf(binding) {
  return binding.handle ??= makeHandle(binding);
}

// set() exists only where the destination writes — a meta handle observes
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
