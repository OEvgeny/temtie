/* ꙋ temtie · core.js */
/// <reference path="./types.d.ts" />
/** @import { Mount, Capture, Commit, Skip, Reset } from 'temtie' */

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

  const anchor = { dest: DEST[ROOT], node: container };
  const ref = makeRef(makeTarget(makeProto(builders), anchor));
  ref.target.placedIn = anchor; // the container is home before the first commit
  debug.enabled && debug.emit({ type: 'mount', target: ref.target, container, builders: Object.keys(builders) });
  return ref.inst;
}

/** @type {Capture} */
export function capture() {
  return makeRef(null).inst;
}

function targetOf(inst, name) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError(`temtie/core: ${name}() expects a target from mount() or capture()`);
  return ref.target;
}

/** @type {Commit} */
export function commit(inst) {
  const target = targetOf(inst, 'commit');
  if (target) commitTarget(target);
}

/** @type {Skip} */
export function skip(inst) {
  const target = targetOf(inst, 'skip');
  if (target?.state !== STAGED) return;
  discard(target);
  call(target, 'skip');
  target.state = SEALED;
}

// a pass dropped before it commits closes the passes it opened, and its moves are undone.
function discard(target) {
  voidOpened(target);
  const moved = [...target.children];
  for (let index = 0; index < moved.length; index++)
    if (!moved[index].placedIn) moved.push(...moved[index].children);
  // a body the pass displaced is in no target's children, only among the leavers
  for (let segment = target.head.next; segment; segment = segment.next)
    for (const binding of segment.bindings)
      for (const { body } of binding.leavers ?? []) if (body && !body.anchor) moved.push(body);
  for (const body of moved) restore(body, target);
  for (let segment = target.head.next; segment; segment = segment.next)
    for (const binding of segment.bindings) restoreHole(binding);
}

// an unplaced target staged by the dropped pass leaves the hole, and any committed plain value returns.
function restoreHole(binding) {
  const occupant = binding.occupant;
  if (occupant?.body && occupant.body.placedIn !== binding) displace(binding);
  const back = binding.leavers?.findLast((occ) => occ.kind === 'plain' && occ.prev !== UNSET);
  if (!back || (binding.occupant && binding.occupant.prev !== UNSET)) return;
  binding.leavers = binding.leavers.filter((occ) => occ !== back);
  binding.occupant = back;
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: back });
}

// a body the pass took from a committed hole goes back. a hole of this target gives up what the pass
// put there. another target's hole keeps what it holds now.
function restore(body, target) {
  const home = body.placedIn, occupant = home?.occupant;
  if (!home || home === body.anchor || (occupant && body.placedUnder !== target) || beneath(body.placedUnder, body)) return;
  // init and render already ran. record the occupant so the flush ends it.
  // a plain occupant was not written.
  if (occupant?.kind === 'instance' || occupant?.kind === 'body') displace(home);
  else if (occupant) home.occupant = null;
  const back = home.leavers?.findLast((occ) => occ.body === body);
  if (back) home.leavers = home.leavers.filter((occ) => occ !== back);
  hook(body.placedUnder, body, home);
  body.unplaced = false;
  // a root's container is not a hole. nothing claims it.
  if (home.dest.kind === ROOT) return;
  home.occupant = back ?? { kind: 'body', body };
  debug.enabled && debug.emit({ type: 'claim', binding: home, occupant: home.occupant });
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
  const target = targetOf(inst, 'reset');
  if (!target) return;
  if (target.state === STAGED) discard(target);
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
    placedUnder: null, // the target that owns placedIn
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
  if (typeof template?.instantiate !== 'function' || !Array.isArray(template.holes))
    throw new TypeError('temtie/core: builder.compile() must return a template { instantiate, holes, keySlot }');
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
  // a pass started over is dropped
  if (target.state === STAGED) discard(target);
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
    { content, start, end, nodes } = template.instantiate(),
    bindings = template.holes.map((hole, index) => makeBinding(builder, hole, nodes[index]));
  return { template, builder, start, end, bindings, values: [], prev: null, next: null, pass: 0, parked: content, sunk: false, clean: false };
}

// the child marker stays. content is the nodes after it.
function makeBinding(builder, hole, node) {
  const dest = DEST[hole.type];
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
    bag: dest.kind === HOLE.SPREAD ? Object.create(null) : null,
  };
}

function emit(target, segment) {
  if (segment === target.cursor) return;
  segment.pass = target.pass;
  const tail = target.cursor.next;
  if (tail === segment) {
    target.cursor = segment;
    return;
  }
  // one segment between the cursor and this one moves behind this one.
  if (tail && tail.next === segment) tail.sunk = true;
  if (segment.prev) {
    segment.prev.next = segment.next;
    if (segment.next) segment.next.prev = segment.prev;
  }
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
      if (!anchor.marker || builder.parent(anchor.marker) !== anchor.node) {
        anchor.marker = lay(anchor, builder);
        anchor.builder = builder;
      }
      return anchor.marker;
    },
  },
  [HOLE.CHILD]: {
    kind: HOLE.CHILD,
    container: (binding) => binding.builder.parent(binding.marker),
    after: (binding) => binding.marker,
    write(binding, value, occupant) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      occupant.after = binding.builder.setChild(binding.marker, occupant.after, value);
    },
    clear(binding, occupant) {
      if (occupant.after && occupant.after !== binding.marker)
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
      binding.builder.setProp(binding.node, binding.prop, binding.dest.container(binding));
    }
  },
  [HOLE.META]: {
    kind: HOLE.META,
    instanceOnly: true,
    container: (binding) => binding.node,
  },
  [HOLE.SPREAD]: {
    kind: HOLE.SPREAD,
    // the bag is this hole's record, not the caller's object. a mutated object passed again is the same value.
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      const next = value == null ? {} : Object(value),
        bag = binding.bag;
      // record each key as it lands: a throw leaves the bag matching the node.
      for (const name of Object.keys(bag))
        if (!(name in next)) {
          binding.builder.unsetProp(binding.node, name);
          delete bag[name];
        }
      for (const name of Object.keys(next))
        if (!same(bag[name], next[name])) {
          binding.builder.setProp(binding.node, name, next[name]);
          bag[name] = next[name];
        }
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
  let clean = !segment.parked;
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
        resolveBody(target, segment, binding, raw[PRIVATE]);
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
  if (binding.leavers?.length) return false;
  const occupant = binding.occupant;
  if (!occupant) return !binding.dest.write;
  return occupant.kind === 'plain' && same(occupant.prev, raw);
}

function resolvePlain(binding) {
  if (binding.occupant?.kind === 'plain') return;
  displace(binding);
  if (!binding.dest.write) return;
  binding.occupant = { kind: 'plain', prev: UNSET, after: binding.marker };
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: binding.occupant });
}

// a fresh capture does not take a body that another hole of the same call carries elsewhere.
const carried = (body, segment) =>
  segment.bindings.some((binding) => segment.values[binding.slot]?.[PRIVATE]?.target === body);

function resolveBody(parent, segment, binding, ref) {
  // meta has no marker. a target cannot anchor there. an instance body can.
  if (binding.dest.instanceOnly)
    throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a target');

  const occupant = binding.occupant,
    child = ref.target
      ?? (occupant?.kind === 'body' && !carried(occupant.body, segment) ? occupant.body : null)
      // a body displaced and not flushed is still committed. a fresh capture reuses it.
      ?? binding.leavers?.findLast((occ) => occ.kind === 'body' && !occ.body.anchor && !carried(occ.body, segment))?.body
      ?? makeTarget(parent.proto, null);
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
      ?? { kind: 'instance', init, ref, body: ref.target, hooks: {}, after: binding.marker };
    if (back) binding.leavers = binding.leavers.filter((occ) => occ !== back);
    debug.enabled && debug.emit({ type: 'claim', binding, occupant });
    hook(parent, occupant.body, binding);
    if (!back) {
      try {
        const made = init(ref.inst, ...props);
        occupant.hooks = typeof made === 'function' ? { render: made } : made ?? {};
      } catch (error) {
        occupant.released = true;
        if (binding.occupant === occupant) displace(binding);
        throw error;
      }
    }
  } else {
    hook(parent, occupant.body, binding);
  }
  occupant.hooks.render?.(occupant.ref.inst, ...props);
}

function hook(parent, child, binding) {
  if (child.anchor === binding) return;
  if (beneath(parent, child))
    throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
  if (child.anchor) leave(child.anchor, child);
  child.parent?.children.delete(child);
  child.parent = parent;
  child.anchor = binding;
  child.unplaced = true;
  // a root's container is not a target: restoring it there has no parent
  parent?.children.add(child);
}

function beneath(parent, child) {
  for (let cursor = parent; cursor; cursor = cursor.parent) if (cursor === child) return true;
  return false;
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
  if (occupant.body?.anchor === binding) unhook(occupant.body);
}

function unhook(body) {
  body.parent?.children.delete(body);
  body.parent = null;
  body.anchor = null;
  body.unplaced = false;
}

function end(binding, occupant, sink) {
  debug.enabled && debug.emit({ type: 'end', binding, occupant });
  // release once per claim: a retry after a later step threw does not release again.
  if (occupant.kind === 'instance' && !occupant.released) {
    occupant.hooks.release?.(handleOf(binding, occupant));
    occupant.released = true;
  }
  binding.dest.clear?.(binding, occupant);
  if (occupant.body) endBody(occupant.body, sink);
}

function endBody(body, sink) {
  if (body.anchor) return; // still anchored: do not dispose
  evictChain(body.head.next);
  if (body.placedIn?.placedBody === body) body.placedIn.placedBody = null;
  body.placedIn = body.placedUnder = null;
  sink(body);
}

// extract a body last placed here once it is no longer anchored here, before this hole is rewritten or removed.
function extractPlaced(binding) {
  const body = binding.placedBody;
  if (!body || body.anchor === binding) return;
  binding.placedBody = null;
  if (body.placedIn === binding) body.placedIn = body.placedUnder = null;
  evictChain(body.head.next);
}

function notePlaced(target) {
  const binding = target.anchor;
  if (!binding) return;
  const old = target.placedIn;
  if (old && old !== binding) {
    if (old.placedBody === target) old.placedBody = null;
    // a root placed in a hole has left its container. its marker goes with it.
    if (old.dest.kind === ROOT && old.marker) {
      if (old.builder.parent(old.marker)) old.builder.remove(old.marker, old.marker);
      old.marker = null;
    }
  }
  target.placedIn = binding;
  target.placedUnder = target.parent;
  binding.placedBody = target;
}

function evictChain(segment) {
  for (; segment; segment = segment.next) park(segment);
}

function park(segment) {
  // extract a placed body that has left before extracting this range.
  for (const binding of segment.bindings) extractPlaced(binding);
  if (!segment.parked && segment.builder.parent(segment.start))
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
    if (!segment.parked && segment.builder.parent(segment.start)) segment.builder.remove(segment.start, segment.end);
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
  if (occupant.kind === 'instance') occupant.hooks.commit?.(handleOf(binding, occupant));
  else if (occupant.kind === 'plain') {
    const value = values[binding.slot];
    if (!same(value, occupant.prev)) {
      // a throw may leave partial changes, so the old value is no longer settled.
      occupant.prev = UNSET;
      binding.dest.write(binding, value, occupant);
      occupant.prev = value;
    }
  }
  // a body is flushed as its own target.
}

function handleOf(binding, occupant) {
  return occupant.handle ??= makeHandle(binding, occupant);
}

// set() exists only where the destination writes. a meta handle has none.
function makeHandle(binding, occupant) {
  const dest = binding.dest,
    handle = {
      kind: dest.kind,
      builder: binding.builder,
      node: binding.node,
      marker: binding.marker,
      prop: binding.prop ?? null,
      name: binding.name,
    };
  if (dest.write) handle.set = (value) => {
    if (!occupant.released) dest.write(binding, value, occupant);
  };
  return handle;
}
