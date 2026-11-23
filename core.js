/* ꙋ temtie · core.js */
/// <reference path="./types.d.ts" />
/** @import { Mount, Capture, Commit, Discard, Reset, Amend } from 'temtie' */

import debug from './debug.js';

const PRIVATE = Symbol('temtie.private');
const VALUE = Symbol.for('temtie.value');
const UNSET = Symbol('temtie.unset');
const ROOT = 'root';

export const TEMPLATE_HOLE_TYPES = {
  CHILD: 'child',
  ATTR: 'attr',
  SPREAD: 'spread',
  META: 'meta',
};
const HOLE = TEMPLATE_HOLE_TYPES;
const EMPTY_PLAN = { finalOwner: new Map() };
const IDLE = 0, PLAN = 1, APPLY = 2;

let PASS = 0;
let PHASE = IDLE;

// SameValueZero. NaN equals NaN.
const same = (a, b) => a === b || (a !== a && b !== b);

// undefined, null, true, and false are not keys. 0, '', and NaN are.
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;

const sameOccupant = (a, b) => a === b || (a?.kind === 'body' && b?.kind === 'body' && a.body === b.body);

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
    anchor: null,
    parent: null,
    children: new Set(),
    committed: [],
    buckets: new Map(),
    placedIn: null,
    ownerClaim: null,
    staged: null,
  };
}

function makeDraft(target, mode) {
  return {
    mode,
    pass: ++PASS,
    base: target.committed,
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
  const target = ref.target = makeTarget(claim.proto);
  target.ownerClaim = claim;
  return target;
}

function targetOf(inst, name, materialize = false) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError(`temtie/core: ${name}() expects a target from mount() or capture()`);
  if (materialize && ref.claim?.usedHole)
    throw new Error('temtie/core: a contract that wrote through handle cannot also stage templates');
  return materialize && !ref.target && ref.claim ? materializeTarget(ref) : ref.target;
}

function beginDraft(target, mode, via) {
  const old = target.staged && !target.staged.sealed ? target.staged : null;
  if (old) voidOpened(target, old.pass);
  const draft = target.staged = makeDraft(target, mode);
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
    if (ref.claim?.usedHole)
      throw new Error('temtie/core: a contract that wrote through handle cannot also stage templates');
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
    seg = {
      site, template, builder, keyed,
      key: keyed ? keyOrIndex : undefined,
      index: keyed ? -1 : keyOrIndex,
      start, end, bindings: null,
      parked: content,
      seenPass: 0, keepPass: 0, oldIndex: -1,
    };
  seg.bindings = template.holes.map((hole, index) => {
    const dest = DEST[hole.type];
    return {
      dest, seg, slot: hole.slot, builder,
      marker: dest.kind === HOLE.CHILD ? nodes[index] : null,
      end: null,
      node: dest.kind === HOLE.CHILD ? null : nodes[index],
      prop: hole.prop, name: hole.name ?? null,
      container: null, occupant: null, placedBody: null,
      bag: dest.kind === HOLE.SPREAD ? Object.create(null) : null,
    };
  });
  return seg;
}

function emitDraft(target, draft, seg, isCommitted) {
  if (seg.seenPass === draft.pass) return;
  seg.seenPass = draft.pass;

  if (draft.mode === 'amend') {
    if (!isCommitted) (draft.list ??= draft.base.slice()).push(seg);
    return;
  }
  if (draft.list === null) {
    if (draft.matched < draft.base.length && draft.base[draft.matched] === seg) {
      draft.matched++;
      return;
    }
    draft.list = draft.base.slice(0, draft.matched);
  }
  draft.list.push(seg);
}

function writeSpread(binding, next) {
  const bag = binding.bag;
  for (const name of Object.keys(bag))
    if (!(name in next)) {
      bag[name] = UNSET;
      binding.builder.unsetProp(binding.node, name);
      delete bag[name];
    }
  for (const name of Object.keys(next))
    if (!same(bag[name], next[name])) {
      bag[name] = UNSET;
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

function reaches(cur, goal, seen = new Set()) {
  if (cur === goal) return true;
  if (seen.has(cur)) return false;
  seen.add(cur);
  const staged = cur.staged;
  if (staged && !staged.sealed) {
    if (staged.children) for (const child of staged.children) if (reaches(child, goal, seen)) return true;
    if (staged.mode === 'amend') for (const child of cur.children) if (reaches(child, goal, seen)) return true;
    return false;
  }
  for (const child of cur.children) if (reaches(child, goal, seen)) return true;
  return false;
}

// Staging records inert data; contract init() and render() run in Commit Pass 1 (Plan).
function resolveSegment(target, draft, seg, values) {
  let edits = draft.edits;
  const setSlot = (binding, occ) => (edits ??= draft.edits = new Map()).set(binding, occ);

  for (const binding of seg.bindings) {
    const raw = values[binding.slot];
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      const init = raw[VALUE];
      if (init !== undefined) {
        if (typeof init !== 'function')
          throw new TypeError('temtie/core: a contract value must carry an init function under Symbol.for("temtie.value")');
        if (!binding.dest.container)
          throw new Error('temtie/core: a spread hole cannot host a contract');
        setSlot(binding, { kind: 'value', init, props: raw.props ?? [] });
        continue;
      }
      if (raw[PRIVATE]) {
        setSlot(binding, { kind: 'body', body: resolveBody(target, draft, seg, binding, raw[PRIVATE], values) });
        continue;
      }
    }
    const occ = binding.occupant;
    if (occ ? (occ.kind === 'plain' && same(occ.prev, raw)) : !binding.dest.write) {
      edits?.delete(binding);
      continue;
    }
    setSlot(binding, { kind: 'plain', prev: raw });
  }
}

function resolveBody(parent, draft, seg, binding, ref, values) {
  if (binding.dest.instanceOnly) throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container) throw new Error('temtie/core: a spread hole cannot host a target');

  const occ = binding.occupant;
  const existing = ref.target
    ?? (ref.claim
      ? materializeTarget(ref)
      : (occ?.kind === 'body' && !carried(occ.body, seg, values) && !draft.takenBodies?.has(occ.body) ? occ.body : null));
  const child = existing ?? makeTarget(parent.proto);

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

const activeLazyBody = (claim) =>
  claim.ref?.target?.staged && !claim.ref.target.staged.sealed && !claim.ref.target.staged.voided
    ? claim.ref.target : null;

const hasClaimBody = (claim) => !!(claim.body || activeLazyBody(claim));

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
      if (PHASE !== IDLE) throw new Error('temtie/core: cannot write through handle while a commit is applying');
      if (hasClaimBody(claim)) throw new Error('temtie/core: a contract with staged content cannot also write through handle.set()');
      claim.usedHole = true;
      if (binding.end) clearRange(binding);
      dest.write(binding, value);
    };
  }
  if (dest.kind === HOLE.CHILD) {
    handle.range = () => {
      if (!claim.alive) return null;
      if (PHASE !== IDLE) throw new Error('temtie/core: cannot claim handle.range() while a commit is applying');
      if (hasClaimBody(claim)) throw new Error('temtie/core: a contract with staged content cannot also claim handle.range()');
      claim.usedHole = true;
      if (!binding.end) {
        const parent = binding.builder.parent(binding.marker);
        if (!parent) return null;
        binding.builder.setChild(binding.marker, null);
        const end = binding.builder.createMarker();
        binding.builder.insert(parent, end, binding.marker);
        binding.end = end;
      }
      return {
        start: binding.marker, end: binding.end, builder: binding.builder,
        clear: () => {
          if (!claim.alive) return;
          if (PHASE !== IDLE) throw new Error('temtie/core: cannot write through handle while a commit is applying');
          clearBetween(binding);
        },
      };
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
  if (n <= 1) { if (n === 1) segs[0].keepPass = mark; return; }
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

function runAll(fns, errors) {
  for (const run of fns) {
    try { run(); }
    catch (error) { errors.push(error); }
  }
}

function throwErrors(errors) {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'temtie/core: multiple errors during cleanup');
}

function withCause(ev, run) {
  if (!ev) return run();
  const cause = debug.cause;
  debug.cause = ev.seq;
  try { return run(); }
  finally { debug.cause = cause; }
}

const settleSpan = (target, type, pass, run) =>
  withCause(debug.enabled && debug.emit({ type, target, pass }), run);

function noteLeaving(binding, occ, leavingBodies, endedClaims) {
  if (!occ) return;
  if (occ.kind === 'body') leavingBodies.push(occ.body);
  else if (occ.kind === 'instance') {
    endedClaims.push({ binding, claim: occ });
    if (occ.body) leavingBodies.push(occ.body);
  }
}

function isLiveBody(body) {
  for (let cur = body; cur; cur = cur.parent) {
    if (!cur.anchor || cur.anchor.occupant?.body !== cur) return false;
    if (cur.anchor.dest.kind === ROOT) return true;
  }
  return false;
}

function collectDisposed(roots, endedClaims) {
  const disposed = new Set();
  for (let i = 0; i < roots.length; i++) {
    const body = roots[i];
    if (!body || disposed.has(body) || isLiveBody(body)) continue;
    disposed.add(body);
    for (const seg of body.committed)
      for (const binding of seg.bindings) {
        const occ = binding.occupant;
        if (occ?.kind === 'instance') endedClaims.push({ binding, claim: occ });
        if (occ?.body) roots.push(occ.body);
      }
  }
  return disposed;
}

function endClaims(list) {
  const releases = [];
  for (const { binding, claim } of list) {
    if (!claim.alive) continue;
    claim.alive = false;
    if (!claim.body && claim.ref?.target?.staged) claim.ref.target.staged = null;
    debug.enabled && debug.emit({ type: 'end', binding, occupant: claim });
    if (claim.hooks?.release) {
      const h = handleOf(binding, claim);
      releases.push(() => claim.hooks.release(h));
    }
  }
  return releases;
}

// Pass 1 (DOM-free): detach drafts, expand contract init()/render(), resolve canonical ownership.
function planCommit(rootTarget, rootAnchor, rootParent) {
  const makeNode = (target, anchor, parent) => ({
    target, anchor, parent, incomingOcc: null,
    draft: null, sealed: false, nextList: target.committed, dropped: null,
    edits: null, children: null, placed: false,
  });
  const rootNode = makeNode(rootTarget, rootAnchor, rootParent);
  const plan = {
    rootNode,
    nodes: new Map([[rootTarget, rootNode]]),
    queue: [rootNode],
    finalOwner: new Map([[rootTarget, { node: null, binding: rootAnchor, parent: rootParent }]]),
    openedClaims: [],
    commits: [],
    settles: [],
  };

  const attachChild = (body, binding, parentNode, explicit, incomingOcc) => {
    const parent = parentNode.target;
    if (explicit) {
      for (let p = parent; p; p = plan.finalOwner.get(p)?.parent ?? p.parent)
        if (p === body)
          throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
    }
    const prev = plan.finalOwner.get(body);
    if (prev) {
      if (!explicit) return;
      // supersede an earlier explicit claim on the same body in this commit
      if (prev.node && prev.binding !== binding)
        (prev.node.edits ??= new Map()).set(prev.binding, null);
    }
    plan.finalOwner.set(body, { node: explicit ? parentNode : null, binding, parent });
    let childNode = plan.nodes.get(body);
    if (childNode) {
      childNode.anchor = binding;
      childNode.parent = parent;
    } else {
      childNode = makeNode(body, binding, parent);
      plan.nodes.set(body, childNode);
      plan.queue.push(childNode);
    }
    if (explicit) childNode.incomingOcc = incomingOcc;
  };

  for (let i = 0; i < plan.queue.length; i++) {
    const node = plan.queue[i], target = node.target;

    if (target.staged?.sealed) { node.sealed = true; continue; }
    if (!target.staged) {
      for (const child of target.children) attachChild(child, child.anchor, node, false, null);
      continue;
    }

    // detach before any user hook runs: reentrant recording starts a separate draft
    const draft = target.staged, committed = target.committed;
    target.staged = null;
    node.draft = draft;

    const nextList = draft.mode === 'amend'
      ? (draft.list ? (draft.base === committed ? draft.list : committed.concat(draft.created ?? [])) : committed)
      : (draft.list ?? (draft.base === committed && draft.matched === committed.length
        ? committed
        : draft.base.slice(0, draft.matched)));
    node.nextList = nextList;

    const touchedBindings = target.children.size ? new Set() : null;
    if (nextList !== committed) {
      const nextSet = draft.mode === 'amend' ? new Set(nextList) : null;
      const dropped = [];
      for (const seg of committed) {
        if (nextSet ? nextSet.has(seg) : seg.seenPass === draft.pass) continue;
        dropped.push(seg);
        if (touchedBindings) for (const binding of seg.bindings) touchedBindings.add(binding);
      }
      if (dropped.length) node.dropped = dropped;
    }

    if (draft.edits) {
      const liveSegs = draft.mode === 'amend' && draft.base !== committed ? new Set(nextList) : null;
      const edits = node.edits = draft.edits;
      for (const [binding, stagedOcc] of edits) {
        if (!stagedOcc) continue;
        if (liveSegs && !liveSegs.has(binding.seg)) { edits.delete(binding); continue; }
        touchedBindings?.add(binding);
        if (stagedOcc.kind === 'plain') {
          if (!binding.dest.write) edits.set(binding, null);
          continue;
        }
        if (stagedOcc.kind === 'body') {
          // child-owning edits publish atomically when their childNode applies
          edits.delete(binding);
          attachChild(stagedOcc.body, binding, node, true, stagedOcc);
          continue;
        }
        // stagedOcc.kind === 'value'
        const { init, props } = stagedOcc, cur = binding.occupant;
        const isNew = !(cur?.kind === 'instance' && cur.init === init && cur.alive);
        let claim = cur;
        if (isNew) {
          claim = {
            kind: 'instance', init, ref: null, body: null, hooks: null,
            alive: true, usedHole: false, handle: null,
            binding: null, owner: null, proto: target.proto,
          };
          claim.ref = makeRef(null, claim);
          const made = init(claim.ref.inst, ...props);
          claim.hooks = typeof made === 'function' ? { render: made } : made ?? {};
          plan.openedClaims.push({ binding, claim });
        }
        claim.hooks.render?.(claim.ref.inst, ...props);
        if (claim.hooks?.commit) plan.commits.push({ binding, claim, isNew });
        if (claim.hooks?.settle) plan.settles.push({ binding, claim });
        const body = claim.body ?? activeLazyBody(claim);
        if (body) {
          edits.delete(binding);
          attachChild(body, binding, node, true, claim);
        } else {
          edits.set(binding, claim);
        }
      }
    }

    if (touchedBindings)
      for (const child of target.children)
        if (!touchedBindings.has(child.anchor)) attachChild(child, child.anchor, node, false, null);
  }

  for (const [body, { parent }] of plan.finalOwner) {
    const parentNode = parent && plan.nodes.get(parent);
    if (parentNode) (parentNode.children ??= []).push(plan.nodes.get(body));
  }

  return plan;
}

function finishApply(plan, applied, failed = false) {
  if (failed) {
    for (const node of plan.nodes.values()) {
      if (!node.placed && node.draft?.created)
        for (const seg of node.draft.created)
          if (!seg.parked && seg.builder.parent(seg.start))
            try { seg.builder.remove(seg.start, seg.end); } catch {}
      if (!node.placed && node.draft) voidOpened(node.target, node.draft.pass);
    }
  }

  const uninstalled = [];
  for (let i = plan.openedClaims.length - 1; i >= 0; i--) {
    const entry = plan.openedClaims[i];
    if (entry.claim.binding !== entry.binding || entry.binding.occupant !== entry.claim)
      uninstalled.push(entry);
  }

  const disposed = collectDisposed(applied.leavingBodies, applied.endedClaims);
  const releases = endClaims(uninstalled);
  for (const run of clearDisposed(disposed, EMPTY_PLAN, applied.endedClaims)) releases.push(run);
  return releases;
}

function commitTarget(rootTarget) {
  if (PHASE !== IDLE) throw new Error('temtie/core: cannot call commit() while a commit is applying');
  if (rootTarget.staged?.sealed) {
    debug.enabled && debug.emit({ type: 'sealed', target: rootTarget, pass: rootTarget.staged.pass });
    return;
  }
  const lazyClaim = !rootTarget.anchor && rootTarget.ownerClaim?.binding && rootTarget.ownerClaim.alive
    ? rootTarget.ownerClaim : null;
  const rootAnchor = rootTarget.anchor ?? lazyClaim?.binding ?? null;
  const rootParent = rootTarget.anchor ? rootTarget.parent : lazyClaim?.owner ?? null;
  if (!rootAnchor) throw new Error('temtie/core: cannot commit an unanchored capture');

  const ev = debug.enabled && debug.emit({
    type: 'commit', target: rootTarget, pass: rootTarget.staged?.pass ?? 0,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(ev, () => {
    const applied = { leavingBodies: [], endedClaims: [] };
    let plan, releases;
    PHASE = PLAN;
    try {
      // Pass 1: Plan (DOM-free)
      plan = planCommit(rootTarget, rootAnchor, rootParent);
      // Pass 2: Apply (pure builder mutations + publication; no user contract hooks)
      PHASE = APPLY;
      try {
        applyNode(plan.rootNode, plan, applied);
        releases = finishApply(plan, applied, false);
      } catch (error) {
        PHASE = IDLE;
        const errors = [error];
        runAll(finishApply(plan, applied, true), errors);
        throwErrors(errors);
      }
    } finally {
      PHASE = IDLE;
    }

    // Pass 3: Effects — Core is settled; release departing claims before arriving commits & settles
    const errors = [];
    runAll(releases, errors);

    for (const { binding, claim, isNew } of plan.commits) {
      if (!claim.alive) continue;
      try {
        claim.hooks.commit(handleOf(binding, claim));
      } catch (error) {
        errors.push(error);
        if (isNew && binding.occupant === claim) {
          if (binding.end) try { clearRange(binding); } catch {}
          if (claim.usedHole) try { binding.dest.clear?.(binding); } catch {}
          binding.occupant = null;
          const ended = [{ binding, claim }];
          const disposed = claim.body ? collectDisposed([claim.body], ended) : [];
          claim.body = null;
          runAll(clearDisposed(disposed, EMPTY_PLAN, ended), errors);
        }
      }
    }

    for (const { binding, claim } of plan.settles) {
      if (!claim.alive) continue;
      try { claim.hooks.settle(handleOf(binding, claim)); }
      catch (error) { errors.push(error); }
    }

    debug.enabled && ev && debug.emit({ type: 'settled', target: rootTarget });
    throwErrors(errors);
  });
}

function inPlace(anchor, seg, prevEnd) {
  const builder = seg.builder, after = prevEnd ?? anchor.dest.after?.(anchor, builder);
  return after
    ? builder.prev(seg.start) === after
    : builder.parent(seg.start) === anchor.dest.container(anchor);
}

const needsPlace = (target, anchor) =>
  target.placedIn !== anchor
  || (target.committed.length > 0 && (target.committed[0].parked !== null || !inPlace(anchor, target.committed[0], null)));

function parkSeg(seg, liftBodies = true) {
  if (liftBodies)
    for (const binding of seg.bindings)
      if (binding.placedBody) for (const s of binding.placedBody.committed) parkSeg(s, true);
  if (!seg.parked && seg.builder.parent(seg.start))
    seg.parked = seg.builder.extract(seg.start, seg.end);
}

function vacateBody(body, plan, applied) {
  if (plan.finalOwner.has(body)) for (const seg of body.committed) parkSeg(seg, true);
  else for (const seg of body.committed) dropSeg(seg, plan, applied);
}

function dropSeg(seg, plan, applied) {
  for (const binding of seg.bindings) {
    if (binding.end) clearRange(binding);
    const occ = binding.occupant;
    if (occ) {
      binding.occupant = null;
      if (applied) noteLeaving(binding, occ, applied.leavingBodies, applied.endedClaims);
    }
    const body = binding.placedBody;
    if (body) { binding.placedBody = null; vacateBody(body, plan, applied); }
  }
  if (!seg.parked && seg.builder.parent(seg.start)) seg.builder.remove(seg.start, seg.end);
  seg.parked = null;
}

function placeChain(target, anchor, list) {
  let prevEnd = null;
  for (const seg of list) {
    if (seg.parked || !inPlace(anchor, seg, prevEnd)) {
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
    prevEnd = seg.end;
  }
}

function deliver(target, anchor) {
  if (!anchor.dest.deliver) return;
  debug.enabled && debug.emit({ type: 'deliver', target, binding: anchor });
  anchor.dest.deliver(anchor);
}

function bindTarget(target, anchor, parent, incomingOcc = null) {
  if (target.parent && target.parent !== parent) target.parent.children.delete(target);
  target.anchor = target.placedIn = anchor;
  target.parent = parent;
  anchor.placedBody = target;
  parent?.children.add(target);
  if (incomingOcc && !sameOccupant(anchor.occupant, incomingOcc)) {
    anchor.occupant = incomingOcc;
    if (incomingOcc.kind === 'instance') {
      incomingOcc.binding = anchor;
      incomingOcc.owner = parent;
      incomingOcc.body = target;
    }
    debug.enabled && debug.emit({ type: 'claim', binding: anchor, occupant: incomingOcc });
  } else if (target.ownerClaim && target.ownerClaim.binding === anchor) {
    target.ownerClaim.body = target;
  }
}

function placeTarget(target, anchor, parent, incomingOcc = null) {
  if (needsPlace(target, anchor)) {
    settleSpan(target, 'place', 0, () => {
      placeChain(target, anchor, target.committed);
      if (target.committed.length) deliver(target, anchor);
    });
  }
  bindTarget(target, anchor, parent, incomingOcc);
}

function placeSubtree(target, anchor, parent, plan, incomingOcc = null) {
  if (!needsPlace(target, anchor)) {
    bindTarget(target, anchor, parent, incomingOcc);
    return;
  }
  placeTarget(target, anchor, parent, incomingOcc);
  for (const child of target.children) {
    const owner = plan.finalOwner.get(child);
    if (!owner || owner.parent === target) placeSubtree(child, child.anchor, target, plan);
  }
}

function vacateBinding(binding, occ, nextKind, plan, applied) {
  if (occ.kind === 'plain') {
    if (nextKind !== 'plain') {
      occ.prev = UNSET;
      if (binding.dest.kind === HOLE.SPREAD) writeSpread(binding, {});
      else binding.dest.clear?.(binding);
    }
    return;
  }
  binding.occupant = null;
  if (applied) noteLeaving(binding, occ, applied.leavingBodies, applied.endedClaims);
  if (occ.kind === 'instance') {
    if (binding.end) clearRange(binding);
    if (occ.usedHole && nextKind !== 'plain') binding.dest.clear?.(binding);
  }
  if (occ.body && binding.placedBody === occ.body) {
    binding.placedBody = null;
    vacateBody(occ.body, plan, applied);
  }
}

function detachHost(host, target, applied) {
  if (host.occupant?.body === target) {
    if (host.occupant.kind === 'instance') applied.endedClaims.push({ binding: host, claim: host.occupant });
    host.occupant = null;
    applied.leavingBodies.push(target);
  }
  if (host.placedBody === target) host.placedBody = null;
  host.dest.vacate?.(host);
}

function applyNode(node, plan, applied) {
  const { target, anchor, parent, incomingOcc, draft, nextList, dropped, edits } = node;

  // Vacate destination anchor if replacing its occupant
  if (incomingOcc && !sameOccupant(anchor.occupant, incomingOcc)) {
    if (anchor.occupant) vacateBinding(anchor, anchor.occupant, incomingOcc.kind, plan, applied);
    anchor.occupant = null;
  }

  // Detach from old host if moving to a new anchor
  if (target.anchor && target.anchor !== anchor) detachHost(target.anchor, target, applied);
  if (target.placedIn && target.placedIn !== anchor && target.placedIn !== target.anchor)
    detachHost(target.placedIn, target, applied);

  if (node.sealed) {
    placeSubtree(target, anchor, parent, plan, incomingOcc);
    node.placed = true;
    debug.enabled && debug.emit({ type: 'sealed', target, pass: target.staged.pass });
    return;
  }

  if (!draft) {
    placeTarget(target, anchor, parent, incomingOcc);
    node.placed = true;
  } else {
    settleSpan(target, 'flush', draft.pass, () => {
      if (dropped?.length) {
        const dropSet = new Set(dropped);
        for (const seg of dropped) {
          debug.enabled && debug.emit({ type: 'drop', target, segment: seg });
          dropSeg(seg, plan, applied);
        }
        pruneDropped(target, dropped);
        target.committed = target.committed.filter((seg) => !dropSet.has(seg));
      }

      const committed = target.committed;
      if (nextList !== committed || target.placedIn !== anchor) {
        if (nextList !== committed && target.placedIn === anchor) {
          const mark = ++PASS;
          markKeepSet(nextList, committed, mark);
          // reordered segments keep their hosted child bodies intact and move as one subtree
          for (const seg of nextList) if (!seg.parked && seg.keepPass !== mark) parkSeg(seg, false);
        }
        placeChain(target, anchor, nextList);
      } else if (nextList.length && (nextList[0].parked !== null || !inPlace(anchor, nextList[0], null))) {
        placeChain(target, anchor, nextList);
      }

      bindTarget(target, anchor, parent, incomingOcc);
      target.committed = nextList;
      node.placed = true;
      if (draft.created) {
        for (const seg of draft.created) {
          let bucket = target.buckets.get(seg.site);
          if (!bucket) target.buckets.set(seg.site, bucket = { byIndex: [], byKey: new Map() });
          if (seg.keyed) bucket.byKey.set(seg.key, seg);
          else bucket.byIndex[seg.index] = seg;
        }
      }

      if (edits) {
        // Apply fallible plain/clear edits before publishing new bodyless claims on this target
        let claims = null;
        for (const [binding, nextOcc] of edits) {
          if (nextOcc?.kind === 'instance') {
            (claims ??= []).push([binding, nextOcc]);
            continue;
          }
          const cur = binding.occupant;
          if (!nextOcc) {
            if (cur) vacateBinding(binding, cur, null, plan, applied);
            binding.occupant = null;
            debug.enabled && debug.emit({ type: 'claim', binding, occupant: null });
            continue;
          }
          let occ = cur;
          if (occ?.kind !== 'plain') {
            if (occ) vacateBinding(binding, occ, 'plain', plan, applied);
            occ = binding.occupant = { kind: 'plain', prev: UNSET };
            debug.enabled && debug.emit({ type: 'claim', binding, occupant: occ });
          } else {
            occ.prev = UNSET;
          }
          binding.dest.write(binding, nextOcc.prev);
          occ.prev = nextOcc.prev;
        }
        if (claims) {
          for (const [binding, claim] of claims) {
            const cur = binding.occupant;
            if (cur !== claim) {
              if (cur) vacateBinding(binding, cur, 'instance', plan, applied);
              binding.occupant = claim;
              claim.binding = binding;
              claim.owner = target;
              debug.enabled && debug.emit({ type: 'claim', binding, occupant: claim });
            }
          }
        }
      }

      deliver(target, anchor);
    });
  }

  if (node.children) for (const child of node.children) applyNode(child, plan, applied);
}

function clearDisposed(bodies, plan, endedClaims) {
  for (const body of bodies) {
    debug.enabled && debug.emit({ type: 'dispose', target: body });
    for (const seg of body.committed) dropSeg(seg, plan, null);
    if (body.placedIn?.placedBody === body) body.placedIn.placedBody = null;
    body.parent?.children.delete(body);
    body.committed = [];
    body.buckets.clear();
    body.children.clear();
    body.staged = body.anchor = body.parent = body.placedIn = null;
  }
  return endClaims(endedClaims);
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
