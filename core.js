/* ꙋ temtie · core.js */
/// <reference path="./types.d.ts" />
/** @import { Mount, Capture, Commit, Discard, Reset, Amend } from 'temtie' */

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

let PASS = 0;

// SameValueZero. NaN equals NaN.
const same = (a, b) => a === b || (a !== a && b !== b);

// undefined, null, true, and false are not keys. 0, '', and NaN are.
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;

function reportError(error) {
  try {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else globalThis.console?.error?.('temtie/core: hook failed', error);
  } catch { /* best-effort */ }
}

/** @type {Mount} */
export function mount(container, { builders } = {}) {
  if (!container) throw new Error(`temtie/core: expected container, got ${String(container)}`);
  if (!builders || typeof builders !== 'object' || !Object.keys(builders).length)
    throw new Error('temtie/core: mount() requires builders, e.g. mount(el, { builders: { html } })');

  // a mounted root is a regular target seated in a uniform container host
  const host = { dest: DEST[ROOT], node: container, marker: null, builder: null, occupant: null, placedBody: null };
  const target = makeTarget(makeProto(builders));
  target.anchor = target.placedIn = host;
  host.occupant = { kind: 'body', body: target };
  host.placedBody = target;

  const ref = makeRef(target);
  debug.enabled && debug.emit({ type: 'mount', target, container, builders: Object.keys(builders) });
  return ref.inst;
}

/** @type {Capture} */
export function capture() {
  return makeRef(null).inst;
}

/** @type {Commit} */
export function commit(inst) {
  const target = targetOf(inst, 'commit');
  if (target) commitTarget(target);
}

/** @type {Discard} */
export function discard(inst) {
  const target = targetOf(inst, 'discard');
  if (!target?.staged || target.staged.sealed) return;
  voidOpened(target, target.staged.pass);
  const pass = ++PASS;
  target.staged = { sealed: true, voided: false, pass, mode: 'replace' };
  debug.enabled && debug.emit({ type: 'call', target, pass, via: 'discard' });
}

/** @type {Reset} */
export function reset(inst) {
  const target = targetOf(inst, 'reset', true);
  if (target) beginDraft(target, 'replace', 'reset');
}

/** @type {Amend} */
export function amend(inst) {
  const target = targetOf(inst, 'amend', true);
  if (target) beginDraft(target, 'amend', 'amend');
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

function makeRef(target, claim = null) {
  const ref = { inst: Object.create(target ? target.proto : claim?.proto ?? null), target, claim };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto) {
  return {
    proto,
    // committed state — never mutated during staging
    anchor: null,
    parent: null,
    children: new Set(),
    committed: [],
    buckets: new Map(),
    placedIn: null,
    // staged draft — null while idle
    staged: null,
  };
}

function makeDraft(mode) {
  return {
    mode,
    pass: ++PASS,
    sealed: false,
    voided: false,
    matched: 0,
    list: null,
    edits: null,
    used: null,
    created: null,
    createdKeys: null,
    children: null,
    takenBodies: null,
  };
}

function materializeTarget(ref) {
  const claim = ref.claim;
  if (claim.usedHole)
    throw new Error('temtie/core: a contract that wrote through handle cannot also stage templates');
  const target = ref.target = claim.body = makeTarget(claim.proto);
  if (claim.committed && claim.binding) {
    target.anchor = claim.binding;
    target.parent = claim.owner;
    claim.owner?.children.add(target);
  }
  return target;
}

function targetOf(inst, name, materialize = false) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError(`temtie/core: ${name}() expects a target from mount() or capture()`);
  return materialize && !ref.target && ref.claim ? materializeTarget(ref) : ref.target;
}

function beginDraft(target, mode, via) {
  if (target.staged && !target.staged.sealed) voidOpened(target, target.staged.pass);
  const draft = target.staged = makeDraft(mode);
  debug.enabled && debug.emit({ type: 'call', target, pass: draft.pass, via });
  return draft;
}

function touch(target) {
  const staged = target.staged;
  return staged && !staged.sealed && !staged.voided ? staged : beginDraft(target, 'replace', 'render');
}

function voidOpened(target, since, seen = new Set()) {
  if (seen.has(target)) return;
  seen.add(target);
  const visit = (child) => {
    voidOpened(child, since, seen);
    if (child.staged && !child.staged.sealed && child.staged.pass > since) child.staged.voided = true;
  };
  for (const child of target.children) visit(child);
  if (target.staged?.children) for (const child of target.staged.children) visit(child);
}

const SITES = new WeakMap(); // builder → strings → { template }

function compile(builder, strings, target, pass) {
  let cache = SITES.get(builder);
  if (!cache) SITES.set(builder, cache = new WeakMap());
  const cached = cache.get(strings);
  if (cached) return cached;

  const ev = debug.enabled && debug.emit({
    type: 'compile', builder, target, pass,
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
    const ref = this[PRIVATE];
    const target = ref.target ?? (ref.claim ? materializeTarget(ref) : null);
    const draft = touch(target);
    const site = compile(builder, strings, target, draft.pass);
    const { seg, fresh, isCommitted } = takeSegment(target, draft, site, values);
    const ev = debug.enabled && debug.emit({
      type: 'stage', target, pass: draft.pass, segment: seg, template: site.template, fresh,
      key: site.template.keySlot >= 0 ? values[site.template.keySlot] : undefined,
      stack: debug.stacks ? new Error('stage') : undefined,
    });
    emitDraft(target, draft, seg, isCommitted);
    withCause(ev, () => resolveSegment(target, draft, seg, values));
  };
}

function takeSegment(target, draft, site, values) {
  const template = site.template,
    key = template.keySlot >= 0 ? values[template.keySlot] : undefined,
    keyed = carriesIdentity(key),
    bucket = target.buckets.get(site);

  let seg, keyOrIndex;
  if (keyed) {
    keyOrIndex = key;
    seg = draft.createdKeys?.get(site)?.get(key) ?? bucket?.byKey.get(key);
    if (seg?.seenPass === draft.pass) {
      debug.enabled && debug.assert(false, 'temtie/core: duplicate key in one pass',
        { assert: 'duplicate-key', target, key, segment: seg });
      return { seg, fresh: false, isCommitted: bucket?.byKey.get(key) === seg };
    }
  } else {
    keyOrIndex = draft.used?.get(site) ?? 0;
    (draft.used ??= new Map()).set(site, keyOrIndex + 1);
    seg = bucket?.byIndex[keyOrIndex];
  }

  if (seg) return { seg, fresh: false, isCommitted: true };

  seg = makeSegment(site, keyOrIndex, keyed);
  (draft.created ??= []).push(seg);
  if (keyed) {
    let byKey = draft.createdKeys?.get(site);
    if (!byKey) (draft.createdKeys ??= new Map()).set(site, byKey = new Map());
    byKey.set(key, seg);
  }
  return { seg, fresh: true, isCommitted: false };
}

function makeSegment(site, keyOrIndex, keyed) {
  const template = site.template,
    builder = template.builder,
    { content, start, end, nodes } = template.instantiate(),
    bindings = template.holes.map((hole, index) => makeBinding(builder, hole, nodes[index]));
  return {
    site, template, builder, keyed,
    key: keyed ? keyOrIndex : undefined,
    index: keyed ? -1 : keyOrIndex,
    start, end, bindings,
    parked: content,
    seenPass: 0,
    keepPass: 0,
    oldIndex: -1,
  };
}

function makeBinding(builder, hole, node) {
  const dest = DEST[hole.type];
  return {
    dest,
    slot: hole.slot,
    builder,
    marker: dest.kind === HOLE.CHILD ? node : null,
    end: null, // lazy closing comment created only by handle.range()
    node: dest.kind === HOLE.CHILD ? null : node,
    prop: hole.prop,
    name: hole.name ?? null,
    container: null,
    occupant: null,
    placedBody: null,
    bag: dest.kind === HOLE.SPREAD ? Object.create(null) : null,
  };
}

function emitDraft(target, draft, seg, isCommitted) {
  if (seg.seenPass === draft.pass) return;
  seg.seenPass = draft.pass;

  if (draft.mode === 'amend') {
    if (!isCommitted) (draft.list ??= target.committed.slice()).push(seg);
    return;
  }
  if (draft.list === null) {
    if (draft.matched < target.committed.length && target.committed[draft.matched] === seg) {
      draft.matched++;
      return;
    }
    draft.list = target.committed.slice(0, draft.matched);
  }
  draft.list.push(seg);
}

function writeSpread(binding, next) {
  const bag = binding.bag;
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

const DEST = {
  [ROOT]: {
    kind: ROOT,
    container: (host) => host.node,
    after(host, builder) {
      if (!host.marker || builder.parent(host.marker) !== host.node) {
        const marker = builder.createMarker();
        builder.insert(host.node, marker, null);
        host.marker = marker;
        host.builder = builder;
      }
      return host.marker;
    },
    vacate(host) {
      if (host.marker && host.builder.parent(host.marker)) host.builder.remove(host.marker, host.marker);
      host.marker = null;
    },
  },
  [HOLE.CHILD]: {
    kind: HOLE.CHILD,
    container: (binding) => binding.builder.parent(binding.marker),
    after: (binding) => binding.marker,
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      binding.builder.setChild(binding.marker, value);
    },
    clear: (binding) => binding.builder.setChild(binding.marker, null),
  },
  [HOLE.ATTR]: {
    kind: HOLE.ATTR,
    container: (binding) => binding.container ??= binding.builder.createRoot(),
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      binding.builder.setProp(binding.node, binding.prop, value);
    },
    clear: (binding) => binding.builder.unsetProp(binding.node, binding.prop),
    deliver: (binding) => binding.builder.setProp(binding.node, binding.prop, binding.dest.container(binding)),
  },
  [HOLE.META]: {
    kind: HOLE.META,
    instanceOnly: true,
    container: (binding) => binding.node,
  },
  [HOLE.SPREAD]: {
    kind: HOLE.SPREAD,
    write(binding, value) {
      debug.enabled && debug.emit({ type: 'write', binding, value });
      writeSpread(binding, value == null ? {} : Object(value));
    },
  },
};

const carried = (body, seg, values) =>
  seg.bindings.some((binding) => values[binding.slot]?.[PRIVATE]?.target === body);

function reaches(node, goal, seen = new Set()) {
  if (node === goal) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  const staged = node.staged;
  if (staged && !staged.sealed) {
    if (staged.children) for (const child of staged.children) if (reaches(child, goal, seen)) return true;
    if (staged.mode === 'amend') for (const child of node.children) if (reaches(child, goal, seen)) return true;
    return false;
  }
  for (const child of node.children) if (reaches(child, goal, seen)) return true;
  return false;
}

function resolveSegment(target, draft, seg, values) {
  let slots = draft.edits?.get(seg) ?? null;
  const setSlot = (binding, occ) => {
    if (!slots) (draft.edits ??= new Map()).set(seg, slots = new Map());
    slots.set(binding, occ);
  };

  for (const binding of seg.bindings) {
    const raw = values[binding.slot];
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      const init = raw[VALUE];
      if (init !== undefined) {
        setSlot(binding, resolveInstance(target, draft, binding, raw, init));
        continue;
      }
      if (raw[PRIVATE]) {
        setSlot(binding, { kind: 'body', body: resolveBody(target, draft, seg, binding, raw[PRIVATE], values) });
        continue;
      }
    }
    const occ = binding.occupant;
    if (occ ? (occ.kind === 'plain' && same(occ.prev, raw)) : !binding.dest.write) {
      slots?.delete(binding);
      continue;
    }
    setSlot(binding, { kind: 'plain', value: raw });
  }
}

function resolveBody(parent, draft, seg, binding, ref, values) {
  if (binding.dest.instanceOnly) throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container) throw new Error('temtie/core: a spread hole cannot host a target');

  const occ = binding.occupant;
  const child = ref.target
    ?? (occ?.kind === 'body' && !carried(occ.body, seg, values) && !draft.takenBodies?.has(occ.body) ? occ.body : null)
    ?? makeTarget(parent.proto);

  if (reaches(child, parent))
    throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
  if (ref.target !== child) {
    ref.target = child;
    Object.setPrototypeOf(ref.inst, child.proto);
  }
  (draft.takenBodies ??= new Set()).add(child);
  (draft.children ??= new Set()).add(child);
  return child;
}

function resolveInstance(parent, draft, binding, raw, init) {
  if (typeof init !== 'function')
    throw new TypeError('temtie/core: a contract value must carry an init function under Symbol.for("temtie.value")');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a contract');

  const props = raw.props ?? [],
    existing = binding.occupant;
  let claim;

  if (existing?.kind === 'instance' && existing.init === init && existing.alive) {
    claim = existing;
  } else {
    // run init before storing in draft: a throw leaves zero residue
    claim = {
      kind: 'instance', init, ref: null, body: null, hooks: null,
      alive: true, committed: false, usedHole: false, handle: null,
      binding: null, owner: null, proto: parent.proto,
    };
    claim.ref = makeRef(null, claim);
    const made = init(claim.ref.inst, ...props);
    claim.hooks = typeof made === 'function' ? { render: made } : made ?? {};
  }

  claim.hooks.render?.(claim.ref.inst, ...props);
  if (claim.body) {
    if (reaches(claim.body, parent))
      throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
    (draft.takenBodies ??= new Set()).add(claim.body);
    (draft.children ??= new Set()).add(claim.body);
  }
  return claim;
}

function clearBetween(binding) {
  const end = binding.end;
  if (!end) return;
  const builder = binding.builder, start = binding.marker, last = builder.prev(end);
  if (last && last !== start) {
    let first = last;
    for (let p = builder.prev(first); p && p !== start; p = builder.prev(first)) first = p;
    builder.remove(first, last);
  }
}

function clearRange(binding) {
  const end = binding.end;
  if (!end) return;
  clearBetween(binding);
  if (binding.builder.parent(end)) binding.builder.remove(end, end);
  binding.end = null;
}

const handleOf = (binding, claim) => claim.handle ??= makeHandle(binding, claim);

function makeHandle(binding, claim) {
  const dest = binding.dest;
  const handle = {
    kind: dest.kind, builder: binding.builder, node: binding.node,
    marker: binding.marker, prop: binding.prop ?? null, name: binding.name,
  };
  if (dest.write) {
    handle.set = (value) => {
      if (!claim.alive) return;
      if (claim.body) throw new Error('temtie/core: a contract with staged content cannot also write through handle.set()');
      claim.usedHole = true;
      if (binding.end) clearRange(binding);
      dest.write(binding, value);
    };
  }
  if (dest.kind === HOLE.CHILD) {
    handle.range = () => {
      if (!claim.alive) return null;
      if (claim.body) throw new Error('temtie/core: a contract with staged content cannot also claim handle.range()');
      claim.usedHole = true;
      if (!binding.end) {
        const parent = binding.builder.parent(binding.marker);
        if (!parent) return null;
        binding.builder.setChild(binding.marker, null);
        const end = binding.builder.createMarker();
        binding.builder.insert(parent, end, binding.marker);
        binding.end = end;
      }
      return { start: binding.marker, end: binding.end, builder: binding.builder, clear: () => { if (claim.alive) clearBetween(binding); } };
    };
  }
  return handle;
}

function markKeepSet(nextList, committed, mark) {
  for (let i = 0; i < committed.length; i++) committed[i].oldIndex = i;
  const seq = [], segs = [];
  for (let i = 0; i < nextList.length; i++) {
    const seg = nextList[i];
    if (!seg.parked && seg.oldIndex >= 0) { seq.push(seg.oldIndex); segs.push(seg); }
  }
  for (let i = 0; i < committed.length; i++) committed[i].oldIndex = -1;

  const n = seq.length;
  if (n <= 1) {
    if (n === 1) segs[0].keepPass = mark;
    return;
  }
  const tails = [], prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const val = seq[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < val) lo = mid + 1; else hi = mid; }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) segs[k].keepPass = mark;
}

function commitTarget(rootTarget) {
  if (rootTarget.staged?.sealed) {
    debug.enabled && debug.emit({ type: 'sealed', target: rootTarget, pass: rootTarget.staged.pass });
    return;
  }
  if (!rootTarget.anchor) throw new Error('temtie/core: cannot commit an unanchored capture');

  const ev = debug.enabled && debug.emit({
    type: 'commit', target: rootTarget, pass: rootTarget.staged?.pass ?? 0,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(ev, () => {
    const tx = {
      touched: [], edits: [], vacated: [],
      flushed: new Map(),
      parkedBodies: new Set(), claimedBodies: new Set([rootTarget]),
      maybeDispose: [], endedClaims: [], releases: [], settles: [],
    };

    try {
      const queue = [{ target: rootTarget, anchor: rootTarget.anchor, parent: rootTarget.parent }];
      const queuedAnchor = new Map([[rootTarget, rootTarget.anchor]]);

      for (let i = 0; i < queue.length; i++) {
        const { target, anchor, parent } = queue[i];
        if (queuedAnchor.get(target) !== anchor) continue; // superseded by a move in this commit
        if (target.staged?.sealed) {
          debug.enabled && debug.emit({ type: 'sealed', target, pass: target.staged.pass });
          continue;
        }
        const alreadyFlushed = tx.flushed.get(target);
        if (alreadyFlushed) {
          settleSpan(target, 'place', () => {
            tx.touched.push({ target, anchor, parent, nextList: alreadyFlushed, draft: null, dropped: null });
            placeChain(target, anchor, alreadyFlushed);
            if (alreadyFlushed.length) deliver(target, anchor);
          });
          continue;
        }
        if (target.staged) {
          settleSpan(target, 'flush', () => applyTarget(target, anchor, parent, tx, queue, queuedAnchor));
        } else {
          if (target.placedIn !== anchor)
            settleSpan(target, 'place', () => {
              tx.touched.push({ target, anchor, parent, nextList: target.committed, draft: null, dropped: null });
              placeChain(target, anchor, target.committed);
              if (target.committed.length) deliver(target, anchor);
            });
          for (const child of target.children)
            if (!queuedAnchor.has(child)) {
              queuedAnchor.set(child, child.anchor);
              tx.claimedBodies.add(child);
              queue.push({ target: child, anchor: child.anchor, parent: target });
            }
        }
      }
    } catch (error) {
      rollbackTx(tx);
      throw error;
    }

    finalizeTx(tx);

    let releaseError = UNSET;
    for (const run of tx.releases) {
      try { run(); }
      catch (error) { if (releaseError === UNSET) releaseError = error; else reportError(error); }
    }
    if (releaseError !== UNSET) throw releaseError;

    for (const run of tx.settles) run();
    debug.enabled && ev && debug.emit({ type: 'settled', target: rootTarget });
  });
}

function settleSpan(target, type, run) {
  const ev = debug.enabled && debug.emit({ type, target, pass: target.staged?.pass ?? 0 });
  withCause(ev, run);
}

function withCause(ev, run) {
  if (!ev) return run();
  const cause = debug.cause;
  debug.cause = ev.seq;
  try { return run(); }
  finally { debug.cause = cause; }
}

function inPlace(anchor, seg, prevEnd) {
  const builder = seg.builder, after = prevEnd ?? anchor.dest.after?.(anchor, builder);
  return after
    ? builder.prev(seg.start) === after
    : builder.parent(seg.start) === anchor.dest.container(anchor);
}

function parkSeg(seg, tx) {
  for (const binding of seg.bindings) if (binding.placedBody) evictBody(binding.placedBody, tx);
  if (!seg.parked && seg.builder.parent(seg.start))
    seg.parked = seg.builder.extract(seg.start, seg.end);
}

function evictBody(body, tx) {
  tx?.parkedBodies.add(body);
  const list = tx?.flushed.get(body) ?? body.committed;
  for (const seg of list) parkSeg(seg, tx);
}

function placeSeg(target, anchor, seg, prevEnd) {
  if (!seg.parked && inPlace(anchor, seg, prevEnd)) return;
  const builder = seg.builder,
    after = prevEnd ?? anchor.dest.after?.(anchor, builder),
    container = anchor.dest.container(anchor);
  if (!seg.parked) {
    debug.enabled && debug.assert(builder.parent(seg.start),
      'temtie/core: cannot place a segment whose nodes left the medium',
      { assert: 'detached-start', target, segment: seg, destination: container });
    seg.parked = builder.extract(seg.start, seg.end);
  }
  debug.enabled && debug.emit({ type: 'move', target, segment: seg, container, after });
  builder.insert(container, seg.parked, after);
  seg.parked = null;
}

function placeChain(target, anchor, list) {
  let prevEnd = null;
  for (const seg of list) {
    placeSeg(target, anchor, seg, prevEnd);
    prevEnd = seg.end;
  }
}

function deliver(target, anchor) {
  if (!anchor.dest.deliver) return;
  debug.enabled && debug.emit({ type: 'deliver', target, binding: anchor });
  anchor.dest.deliver(anchor);
}

function noteLeaving(binding, occ, tx) {
  if (!occ) return;
  if (occ.kind === 'body') tx.maybeDispose.push(occ.body);
  else if (occ.kind === 'instance') {
    tx.endedClaims.push({ binding, claim: occ });
    if (occ.body) tx.maybeDispose.push(occ.body);
  }
}

function vacateDom(binding, occ, tx, nextKind) {
  if (!occ) return;
  if (occ.kind === 'plain') {
    if (nextKind !== 'plain') {
      if (binding.dest.kind === HOLE.SPREAD) writeSpread(binding, {});
      else binding.dest.clear?.(binding);
    }
  } else if (occ.kind === 'body') {
    if (binding.placedBody === occ.body) evictBody(occ.body, tx);
  } else if (occ.kind === 'instance') {
    occ.hooks?.clear?.(handleOf(binding, occ));
    if (binding.end) clearRange(binding);
    if (occ.usedHole && nextKind !== 'plain') binding.dest.clear?.(binding);
    if (occ.body && binding.placedBody === occ.body) evictBody(occ.body, tx);
  }
}

function applyTarget(target, anchor, parent, tx, queue, queuedAnchor) {
  const draft = target.staged, committed = target.committed;
  const nextList = draft.mode === 'amend'
    ? (draft.list ?? committed)
    : (draft.list ?? (draft.matched === committed.length ? committed : committed.slice(0, draft.matched)));

  const dropped = [];
  const droppedBindings = new Set();
  tx.touched.push({ target, anchor, parent, nextList, draft, dropped });
  tx.flushed.set(target, nextList);

  if (nextList !== committed) {
    const nextSet = draft.mode === 'amend' ? new Set(nextList) : null;
    for (const seg of committed) {
      if (nextSet ? nextSet.has(seg) : seg.seenPass === draft.pass) continue;
      debug.enabled && debug.emit({ type: 'drop', target, segment: seg });
      dropped.push(seg);
      for (const binding of seg.bindings) {
        droppedBindings.add(binding);
        noteLeaving(binding, binding.occupant, tx);
      }
      parkSeg(seg, tx);
    }
  }

  if (nextList !== committed || target.placedIn !== anchor) {
    if (nextList !== committed && target.placedIn === anchor) {
      const mark = ++PASS;
      markKeepSet(nextList, committed, mark);
      for (const seg of nextList) if (!seg.parked && seg.keepPass !== mark) parkSeg(seg, tx);
    }
    placeChain(target, anchor, nextList);
  } else if (nextList.length && !inPlace(anchor, nextList[0], null)) {
    placeChain(target, anchor, nextList);
  }

  if (draft.edits) {
    for (const slots of draft.edits.values()) {
      for (const [binding, stagedOcc] of slots) {
        droppedBindings.add(binding);
        const cur = binding.occupant;
        const prevBag = binding.dest.kind === HOLE.SPREAD ? { ...binding.bag } : null;

        if (stagedOcc.kind === 'plain') {
          const nextOcc = binding.dest.write ? { kind: 'plain', prev: stagedOcc.value } : null;
          tx.edits.push({ binding, nextOcc, owner: target, prevBag, committedNew: false });
          if (cur && cur.kind !== 'plain') {
            vacateDom(binding, cur, tx, 'plain');
            noteLeaving(binding, cur, tx);
          }
          if (binding.dest.write) binding.dest.write(binding, stagedOcc.value);
          continue;
        }

        if (stagedOcc.kind === 'body') {
          const child = stagedOcc.body;
          tx.claimedBodies.add(child);
          if (cur?.kind !== 'body' || cur.body !== child) {
            tx.edits.push({ binding, nextOcc: { kind: 'body', body: child }, owner: target, prevBag, committedNew: false });
            if (cur) {
              vacateDom(binding, cur, tx, 'body');
              noteLeaving(binding, cur, tx);
            }
            if (child.anchor && child.anchor !== binding) {
              const oldHost = child.anchor;
              tx.vacated.push({ host: oldHost, child, prevParent: child.parent });
              if (oldHost.occupant?.kind === 'instance' && oldHost.occupant.body === child)
                tx.endedClaims.push({ binding: oldHost, claim: oldHost.occupant });
              if (child.placedIn === oldHost || tx.flushed.has(child)) evictBody(child, tx);
            }
          }
          if (queuedAnchor.get(child) !== binding) {
            queuedAnchor.set(child, binding);
            queue.push({ target: child, anchor: binding, parent: target });
          }
          continue;
        }

        const claim = stagedOcc, isNew = claim !== cur;
        let editEntry = null;
        if (isNew) {
          editEntry = { binding, nextOcc: claim, owner: target, prevBag, committedNew: false };
          tx.edits.push(editEntry);
          if (cur) {
            vacateDom(binding, cur, tx, 'instance');
            noteLeaving(binding, cur, tx);
          }
        }
        claim.hooks?.commit?.(handleOf(binding, claim));
        if (editEntry) editEntry.committedNew = true;
        if (claim.hooks?.settle) tx.settles.push(() => claim.hooks.settle(handleOf(binding, claim)));
        if (claim.body) {
          tx.claimedBodies.add(claim.body);
          if (queuedAnchor.get(claim.body) !== binding) {
            queuedAnchor.set(claim.body, binding);
            queue.push({ target: claim.body, anchor: binding, parent: target });
          }
        }
      }
    }
  }

  for (const child of target.children) {
    if (queuedAnchor.has(child) || droppedBindings.has(child.anchor)) continue;
    queuedAnchor.set(child, child.anchor);
    tx.claimedBodies.add(child);
    queue.push({ target: child, anchor: child.anchor, parent: target });
  }

  deliver(target, anchor);
}

function finalizeTx(tx) {
  for (const { host, child, prevParent } of tx.vacated) {
    if (host.occupant?.body === child) host.occupant = null;
    if (host.placedBody === child) host.placedBody = null;
    host.dest.vacate?.(host);
    prevParent?.children.delete(child);
  }

  for (const { binding, nextOcc, owner } of tx.edits) {
    binding.occupant = nextOcc;
    if (nextOcc?.kind === 'instance') {
      nextOcc.committed = true;
      nextOcc.binding = binding;
      nextOcc.owner = owner;
    }
    debug.enabled && debug.emit({ type: 'claim', binding, occupant: nextOcc });
  }

  for (const { target, anchor, parent, nextList, draft, dropped } of tx.touched) {
    const oldPlaced = target.placedIn;
    if (oldPlaced && oldPlaced !== anchor) {
      if (oldPlaced.placedBody === target) oldPlaced.placedBody = null;
      oldPlaced.dest.vacate?.(oldPlaced);
    }
    target.anchor = target.placedIn = anchor;
    target.parent = parent;
    anchor.placedBody = target;
    parent?.children.add(target);

    if (draft) {
      target.committed = nextList;
      if (draft.created) {
        for (const seg of draft.created) {
          let bucket = target.buckets.get(seg.site);
          if (!bucket) target.buckets.set(seg.site, bucket = { byIndex: [], byKey: new Map() });
          if (seg.keyed) bucket.byKey.set(seg.key, seg);
          else bucket.byIndex[seg.index] = seg;
        }
      }
      if (dropped?.length) pruneDropped(target, dropped);
      target.staged = null;
    }
  }

  const queue = tx.maybeDispose, disposed = new Set();
  for (let i = 0; i < queue.length; i++) {
    const body = queue[i];
    if (!body || tx.claimedBodies.has(body) || disposed.has(body)) continue;
    disposed.add(body);
    debug.enabled && debug.emit({ type: 'dispose', target: body });
    for (const seg of body.committed)
      for (const binding of seg.bindings) {
        if (binding.occupant?.kind === 'instance') tx.endedClaims.push({ binding, claim: binding.occupant });
        if (binding.occupant?.body) queue.push(binding.occupant.body);
      }
    if (body.placedIn?.placedBody === body) body.placedIn.placedBody = null;
    body.parent?.children.delete(body);
    body.committed = [];
    body.buckets.clear();
    body.children.clear();
    body.staged = body.anchor = body.parent = body.placedIn = null;
  }

  for (const { binding, claim } of tx.endedClaims) {
    if (!claim.alive) continue;
    claim.alive = false;
    debug.enabled && debug.emit({ type: 'end', binding, occupant: claim });
    if (claim.hooks?.release) {
      const h = handleOf(binding, claim);
      tx.releases.push(() => claim.hooks.release(h));
    }
  }
}

function pruneDropped(target, dropped) {
  const touched = new Set();
  for (const seg of dropped) {
    const bucket = target.buckets.get(seg.site);
    if (!bucket) continue;
    touched.add(seg.site);
    if (seg.keyed) { if (bucket.byKey.get(seg.key) === seg) bucket.byKey.delete(seg.key); }
    else if (bucket.byIndex[seg.index] === seg) bucket.byIndex[seg.index] = undefined;
  }
  for (const site of touched) {
    const bucket = target.buckets.get(site);
    while (bucket.byIndex.length && !bucket.byIndex[bucket.byIndex.length - 1]) bucket.byIndex.pop();
    if (!bucket.byKey.size && !bucket.byIndex.length) target.buckets.delete(site);
  }
}

// restores DOM back to V1 when Phase 1 throws; target.committed and target.staged remain intact
function rollbackTx(tx) {
  // 1. Undo newly committed V2 claims while their segments are still mounted
  for (let i = tx.edits.length - 1; i >= 0; i--) {
    const { binding, nextOcc, committedNew } = tx.edits[i];
    if (!committedNew || nextOcc?.kind !== 'instance') continue;
    const h = handleOf(binding, nextOcc);
    try { nextOcc.hooks?.clear?.(h); } catch { /* best-effort */ }
    if (binding.end) clearRange(binding);
    if (nextOcc.usedHole) try { binding.dest.clear?.(binding); } catch { /* best-effort */ }
    nextOcc.alive = false;
    try { nextOcc.hooks?.release?.(h); } catch { /* best-effort */ }
  }

  // 2. Park V2-only segments and re-place V1 committed segments & parked bodies
  for (let i = tx.touched.length - 1; i >= 0; i--) {
    const { target, nextList } = tx.touched[i];
    const keep = new Set(target.committed);
    for (const seg of nextList) if (!keep.has(seg)) parkSeg(seg);
    if (target.placedIn) {
      placeChain(target, target.placedIn, target.committed);
      if (target.committed.length) deliver(target, target.placedIn);
    }
  }
  for (const body of tx.parkedBodies)
    if (body.placedIn) placeChain(body, body.placedIn, body.committed);

  // 3. Restore V1 plain / spread / driver hole state now that V1 segments are back in DOM
  for (let i = tx.edits.length - 1; i >= 0; i--) {
    const { binding, prevBag } = tx.edits[i];
    const prev = binding.occupant;
    try {
      if (binding.dest.kind === HOLE.SPREAD) writeSpread(binding, prevBag ?? {});
      else if (prev?.kind === 'plain') binding.dest.write?.(binding, prev.prev);
      else if (prev?.kind === 'instance') prev.hooks?.commit?.(handleOf(binding, prev));
      else binding.dest.clear?.(binding);
    } catch { /* best-effort */ }
  }
}
