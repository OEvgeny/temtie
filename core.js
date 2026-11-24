/* ꙋ temtie · core.js */
/// <reference path="./types.d.ts" />
/** @import { Mount, Capture, Commit, Discard, Reset, Amend } from 'temtie' */

import debug from './debug.js';

const PRIVATE = Symbol('temtie.private');
const VALUE = Symbol.for('temtie.value');
const UNSET = Symbol('temtie.unset');
const CLEAR = Symbol('temtie.clear');
const STAGED = Symbol('temtie.staged');
const ROOT = 'root';
const CYCLE_ERR = 'temtie/core: a target cannot be anchored beneath its descendant';

export const TEMPLATE_HOLE_TYPES = {
  CHILD: 'child',
  ATTR: 'attr',
  SPREAD: 'spread',
};
const HOLE = TEMPLATE_HOLE_TYPES;
const IDLE = 0, APPLY = 1, EFFECTS = 2;
const EMPTY_LIST = Object.freeze([]);
const STAGING = new Set();

let PASS = 0;
let PHASE = IDLE;

const same = (a, b) => a === b || (a !== a && b !== b);
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;
const sameOccupant = (a, b) => a === b || (a?.kind === 'body' && b?.kind === 'body' && a.body === b.body);
const isOwnedAnchored = (ref) => !!(ref.target?.anchor && ref.target.owner === ref);
const coerceChild = (value) => (value == null || value === false ? '' : String(value));
const commitOf = (spec) => (typeof spec === 'function' ? null : spec.commit);

function assertCanStage(op) {
  if (PHASE === APPLY) throw new Error(`temtie/core: cannot ${op} while a commit is applying`);
}

function assertNotStaging(ref) {
  if (STAGING.has(ref)) throw new Error('temtie/core: cannot mutate a target while staging its own template');
}

function stageRefOf(inst, via) {
  assertCanStage(`${via}()`);
  const ref = refOf(inst, via);
  assertNotStaging(ref);
  return ref;
}

/** @type {Mount} */
export function mount(container, builders) {
  if (!container) throw new Error(`temtie/core: expected container, got ${String(container)}`);
  if (!builders || typeof builders !== 'object' || typeof builders.compile === 'function' || !Object.keys(builders).length)
    throw new Error('temtie/core: mount() requires builders, e.g. mount(el, { html })');

  // a mounted root is a regular target seated in a uniform container host
  const host = { dest: DEST[ROOT], node: container, marker: null, builder: null, occupant: null };
  const target = makeTarget(makeProto(builders));
  const ref = makeRef(target);
  target.owner = ref;
  target.anchor = host;
  host.occupant = { kind: 'body', body: target };

  debug.enabled && debug.emit({ type: 'mount', target, container, builders: Object.keys(builders) });
  return ref.inst;
}

/** @type {Capture} */
export function capture() {
  return makeRef(null).inst;
}

/** @type {Commit} */
export function commit(inst) {
  if (PHASE === APPLY || STAGING.size)
    throw new Error('temtie/core: cannot call commit() while staging or applying');
  if (PHASE === EFFECTS)
    throw new Error('temtie/core: cannot call commit() while effects are running');
  const rootRef = refOf(inst, 'commit');
  const ev = debug.enabled && debug.emit({
    type: 'commit', target: rootRef.target, pass: rootRef.draft?.pass ?? 0,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(ev, () => {
    const plan = planCommit(rootRef);
    for (const ref of plan.committedRefs) {
      clearOwners(ref);
      if (ref.draft) {
        dropFrom(ref.draft.children, 'owners', ref.draft);
        ref.draft.children = null;
        ref.draft = null;
      }
    }

    const applied = { leaving: [], ended: [], commits: [] };
    const errors = [];
    let releases = null;

    PHASE = APPLY;
    try {
      applyPlan(plan.rootNode, plan.liveTargets, applied);
    } catch (error) {
      errors.push(error);
    } finally {
      releases = disposeBodies(applied.leaving, applied.ended);
      PHASE = EFFECTS;
    }

    try {
      const applyFailed = errors.length > 0;
      if (releases) for (const run of releases) tryStep(errors, run);
      if (!applyFailed) {
        for (const { claim, next } of applied.commits) {
          if (!claim.alive) continue;
          const prev = claim.committed === UNSET ? undefined : claim.committed;
          tryStep(errors, () => {
            claim.spec.commit(handleOf(claim), prev, next);
            claim.committed = next;
          });
        }
        debug.enabled && ev && debug.emit({ type: 'settled', target: plan.rootNode.target });
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'temtie/core: multiple errors during cleanup');
    } finally {
      PHASE = IDLE;
    }
  });
}

/** @type {Discard} */
export function discard(inst) {
  const ref = stageRefOf(inst, 'discard');
  if (!ref.draft) return;
  discardDraft(ref.draft);
  debug.enabled && debug.emit({ type: 'call', target: ref.target, pass: ++PASS, via: 'discard' });
}

/** @type {Reset} */
export function reset(inst) {
  const ref = stageRefOf(inst, 'reset');
  if (ref.target) beginDraft(ref, 'replace', 'reset');
}

/** @type {Amend} */
export function amend(inst) {
  const ref = stageRefOf(inst, 'amend');
  if (ref.target) beginDraft(ref, 'amend', 'amend');
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
  const ref = { inst: Object.create(target ? target.proto : null), target, draft: null, owners: null, claim };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto, owner = null) {
  return {
    proto, owner, anchor: null, parent: null, children: new Set(),
    committed: [], buckets: new Map(), rev: 0,
  };
}

function refOf(inst, name) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError(`temtie/core: ${name}() expects a target from mount() or capture()`);
  return ref;
}

function setTarget(ref, target) {
  ref.target = target;
  Object.setPrototypeOf(ref.inst, target ? target.proto : null);
}

function detachRef(ref) {
  if (!ref.target || isOwnedAnchored(ref)) return;
  if (ref.target.owner === ref) ref.target.owner = null;
  setTarget(ref, null);
}

const dropFrom = (set, key, self) => {
  if (set) for (const x of set) x[key]?.delete(self);
};

function clearOwners(ref) {
  dropFrom(ref.owners, 'children', ref);
  ref.owners = null;
}

function releaseOwner(ref) {
  if (ref.draft) discardDraft(ref.draft);
  clearOwners(ref);
  setTarget(ref, null);
}

function hasAncestor(draft, targetRef) {
  const seen = new Set([draft.ref]), stack = [draft.ref];
  for (let i = 0; i < stack.length; i++) {
    const ref = stack[i];
    if (ref === targetRef) return true;
    if (ref.owners) for (const p of ref.owners) if (!seen.has(p.ref)) { seen.add(p.ref); stack.push(p.ref); }
  }
  return false;
}

function linkChild(parentDraft, childRef) {
  if (parentDraft.ref === childRef) return;
  if (isOwnedAnchored(childRef) && !childRef.owners?.size
    && (childRef.draft || childRef.target.parent !== parentDraft.ref.target)) return;
  if (childRef.draft?.children?.size && hasAncestor(parentDraft, childRef)) return;
  (parentDraft.children ??= new Set()).add(childRef);
  (childRef.owners ??= new Set()).add(parentDraft);
}

function discardDraft(rootDraft) {
  const queue = [rootDraft];
  for (let i = 0; i < queue.length; i++) {
    const d = queue[i];
    if (d.ref.draft === d) d.ref.draft = null;
    if (d.children) {
      for (const child of d.children) {
        child.owners?.delete(d);
        if (!child.owners?.size) {
          if (child.draft) queue.push(child.draft);
          else detachRef(child);
        }
      }
      d.children = null;
    }
    if (!d.ref.owners?.size && !d.ref.draft) detachRef(d.ref);
  }
}

function makeDraft(ref, mode, target = ref.target, tentative = !!(target && target.owner !== ref)) {
  return {
    ref, mode, pass: ++PASS,
    base: target ? target.committed : EMPTY_LIST,
    baseRev: target ? target.rev : 0,
    tentative, matched: 0, list: null, edits: null,
    used: null, created: null, seenKeys: null,
    children: null, calls: tentative ? [] : null,
  };
}

function beginDraft(ref, mode, via) {
  const prev = ref.draft;
  const draft = ref.draft = makeDraft(ref, mode);
  if (prev) discardDraft(prev);
  debug.enabled && debug.emit({ type: 'call', target: ref.target, pass: draft.pass, via });
  return draft;
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

function pickSegment(target, draft, site, keyed, key) {
  const bucket = target.buckets.get(site);
  let seg, keyOrIndex;
  if (keyed) {
    keyOrIndex = key;
    let seen = draft.seenKeys?.get(site);
    if (seen?.has(key)) throw new Error('temtie/core: duplicate key in one pass');
    if (!seen) (draft.seenKeys ??= new Map()).set(site, seen = new Set());
    seen.add(key);
    seg = bucket?.byKey.get(key);
  } else {
    keyOrIndex = draft.used?.get(site) ?? 0;
    (draft.used ??= new Map()).set(site, keyOrIndex + 1);
    seg = bucket?.byIndex[keyOrIndex];
  }
  if (!seg) {
    seg = makeSegment(site, keyOrIndex, keyed);
    (draft.created ??= []).push(seg);
  }
  return seg;
}

function appendSegment(draft, seg) {
  if (draft.mode === 'amend') return;
  if (draft.list === null && draft.matched < draft.base.length && draft.base[draft.matched] === seg) {
    draft.matched++;
  } else {
    (draft.list ??= draft.base.slice(0, draft.matched)).push(seg);
  }
}

function makeChannel(builder) {
  return function channel(strings, ...values) {
    assertCanStage('stage templates');
    const ref = this[PRIVATE];
    assertNotStaging(ref);
    const target = ref.target;
    if (!target) throw new Error('temtie/core: cannot stage into a detached capture');
    const draft = ref.draft ?? beginDraft(ref, 'replace', 'render');
    const site = compile(builder, strings, target, draft.pass);
    const template = site.template,
      key = template.keySlot >= 0 ? values[template.keySlot] : undefined,
      keyed = carriesIdentity(key),
      createdBefore = draft.created?.length ?? 0,
      seg = pickSegment(target, draft, site, keyed, key),
      fresh = (draft.created?.length ?? 0) > createdBefore;

    const ev = debug.enabled && debug.emit({
      type: 'stage', target, pass: draft.pass, segment: seg, template, fresh,
      key, stack: debug.stacks ? new Error('stage') : undefined,
    });

    appendSegment(draft, seg);

    STAGING.add(ref);
    let slots;
    try {
      slots = withCause(ev, () => resolveSegment(ref, draft, seg, values));
    } finally {
      STAGING.delete(ref);
    }
    if (slots) draft.calls.push({ seg, slots });
  };
}

function makeSegment(site, keyOrIndex, keyed) {
  const template = site.template,
    builder = template.builder,
    { content, start, end, nodes } = template.instantiate(),
    seg = {
      site, template, builder, keyed,
      key: keyed ? keyOrIndex : undefined,
      index: keyed ? -1 : keyOrIndex,
      start, end, bindings: null, parked: content,
      keepPass: 0, oldIndex: -1,
    };
  seg.bindings = template.holes.map((hole, index) => {
    const dest = DEST[hole.type];
    return {
      dest, seg, slot: hole.slot, builder,
      marker: dest.kind === HOLE.CHILD ? nodes[index] : null,
      node: dest.kind === HOLE.CHILD ? null : nodes[index],
      prop: hole.prop, container: null, occupant: null,
      bag: dest.kind === HOLE.SPREAD ? Object.create(null) : null,
    };
  });
  return seg;
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

function writeHole(binding, value) {
  debug.enabled && debug.emit({ type: 'write', binding, value });
  binding.dest.write(binding, value);
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
    write: (binding, value) => binding.builder.setChild(binding.marker, value),
    clear: (binding) => binding.builder.setChild(binding.marker, ''),
  },
  [HOLE.ATTR]: {
    kind: HOLE.ATTR,
    container: (binding) => binding.container ??= binding.builder.createRoot(),
    write: (binding, value) => binding.builder.setProp(binding.node, binding.prop, value),
    clear: (binding) => binding.builder.unsetProp(binding.node, binding.prop),
    deliver: (binding) => binding.builder.setProp(binding.node, binding.prop, binding.dest.container(binding)),
  },
  [HOLE.SPREAD]: {
    kind: HOLE.SPREAD,
    write: (binding, value) => writeSpread(binding, value == null ? {} : Object(value)),
    clear: (binding) => writeSpread(binding, {}),
  },
};

function resolveSegment(ref, draft, seg, values) {
  const target = ref.target;
  const slots = draft.tentative ? [] : null;
  let edits = draft.edits;
  const setSlot = (binding, entry) => {
    (edits ??= draft.edits = new Map()).set(binding, entry);
    slots?.push(entry);
  };

  for (const binding of seg.bindings) {
    const raw = values[binding.slot];
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      const spec = raw[VALUE];
      if (spec !== undefined) {
        setSlot(binding, resolveClaim(target, draft, binding, spec, raw));
        continue;
      }
      const childRef = raw[PRIVATE];
      if (childRef) {
        resolveBody(target, draft, binding, childRef);
        setSlot(binding, { [STAGED]: 'body', ref: childRef });
        continue;
      }
    }
    const val = binding.dest.kind === HOLE.CHILD ? coerceChild(raw) : raw;
    const occ = binding.occupant;
    if (!draft.tentative && occ?.kind === 'plain' && same(occ.prev, val)) {
      edits?.delete(binding);
      continue;
    }
    setSlot(binding, val);
  }
  return slots;
}

function resolveBody(parentTarget, draft, binding, childRef) {
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a target');
  if (childRef.claim)
    throw new Error('temtie/core: a contract target cannot be moved to another hole');

  if (!childRef.target) {
    const occ = binding.occupant;
    setTarget(childRef, occ?.kind === 'body' ? occ.body : makeTarget(parentTarget.proto, childRef));
  }
  linkChild(draft, childRef);
}

function resolveClaim(parentTarget, draft, binding, spec, raw) {
  if ((typeof spec !== 'object' || spec === null) && typeof spec !== 'function')
    throw new TypeError('temtie/core: contract value requires a descriptor or function under Symbol.for("temtie.value")');
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a contract');

  const cur = binding.occupant,
    sameSpec = cur?.kind === 'instance' && cur.spec === spec && cur.alive,
    reused = !draft.tentative && sameSpec,
    stageFn = typeof spec === 'function' ? spec : spec.stage;

  let claim, stageRef = null;
  if (reused) {
    claim = cur;
    stageRef = claim.ref;
  } else {
    claim = {
      kind: 'instance', spec, staged: UNSET, committed: UNSET,
      ref: null, body: null, alive: true, usedHole: false, handle: null, binding: null,
    };
    if (stageFn) {
      // tentative parent borrows the standing claim's body for CoW segment reuse without aliasing cur.ref
      const body = (draft.tentative && sameSpec && cur.body) || makeTarget(parentTarget.proto);
      stageRef = claim.ref = makeRef(body, claim);
      if (!body.owner) body.owner = stageRef;
    }
  }

  if (stageFn) {
    linkChild(draft, stageRef);
    stageFn(stageRef.inst, reused && claim.staged !== UNSET ? claim.staged : undefined, raw);
  }

  return { [STAGED]: 'claim', claim, next: raw, stageRef };
}

function handleOf(claim) {
  if (claim.handle) return claim.handle;
  const binding = claim.binding, dest = binding.dest;
  const handle = {
    kind: dest.kind, builder: binding.builder, node: binding.node,
    marker: binding.marker, prop: binding.prop ?? null,
    target: claim.ref?.inst ?? null,
  };
  if (!claim.ref) {
    handle.set = (value) => {
      if (!claim.alive) return;
      assertCanStage('write through handle.set()');
      claim.usedHole = true;
      writeHole(binding, dest.kind === HOLE.CHILD ? coerceChild(value) : value);
    };
  }
  return claim.handle = handle;
}

function markKeepSet(nextList) {
  const seq = [], segs = [];
  let prevIdx = -1, ordered = true;
  for (let i = 0; i < nextList.length; i++) {
    const seg = nextList[i];
    if (seg.parked) continue;
    if (seg.oldIndex < prevIdx) ordered = false;
    prevIdx = seg.oldIndex;
    seq.push(seg.oldIndex);
    segs.push(seg);
  }
  if (ordered) return 0;
  const n = seq.length, mark = ++PASS, tails = [], prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const val = seq[i];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < val) lo = mid + 1; else hi = mid; }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  }
  for (let k = tails[tails.length - 1]; k >= 0; k = prev[k]) segs[k].keepPass = mark;
  return mark;
}

function tryStep(errors, fn) {
  try { fn(); }
  catch (error) { errors.push(error); }
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

const nextListOf = (draft, committed) => (draft.mode === 'amend'
  ? (draft.created ? committed.concat(draft.created) : committed)
  : (draft.list ?? (draft.base === committed && draft.matched === committed.length
    ? committed
    : draft.base.slice(0, draft.matched))));

function noteLeaving(occ, applied) {
  if (occ.kind === 'instance') applied.ended.push(occ);
  if (occ.body) applied.leaving.push(occ.body);
}

function isLiveBody(body) {
  for (let cur = body; cur; cur = cur.parent) {
    if (!cur.anchor || cur.anchor.occupant?.body !== cur) return false;
    if (cur.anchor.dest.kind === ROOT) return true;
  }
  return false;
}

function disposeBodies(roots, endedClaims) {
  if (roots.length) {
    const disposed = new Set(), sink = { leaving: roots, ended: endedClaims };
    for (let i = 0; i < roots.length; i++) {
      const body = roots[i];
      if (!body || disposed.has(body) || isLiveBody(body)) continue;
      disposed.add(body);
      debug.enabled && debug.emit({ type: 'dispose', target: body });
      evictSegs(body.committed, null, sink);
      if (body.anchor?.occupant?.body === body) body.anchor.occupant = null;
      body.parent?.children.delete(body);
      if (body.owner?.target === body) releaseOwner(body.owner);
      body.owner = null;
      body.committed = [];
      body.buckets.clear();
      body.children.clear();
      body.anchor = body.parent = null;
    }
  }
  if (!endedClaims.length) return null;
  const releases = [];
  for (const claim of endedClaims) {
    if (!claim.alive) continue;
    claim.alive = false;
    debug.enabled && debug.emit({ type: 'end', binding: claim.binding, occupant: claim });
    const releaseFn = typeof claim.spec === 'function' ? null : claim.spec.release;
    if (!releaseFn) continue;
    const cur = commitOf(claim.spec) ? claim.committed : claim.staged;
    if (cur === UNSET) continue;
    const h = handleOf(claim);
    releases.push(() => releaseFn(h, cur));
  }
  return releases.length ? releases : null;
}

function replayDraft(node, newTarget, byRef) {
  const orig = node.draft;
  if (!orig) return;
  const rDraft = makeDraft(node.ref, orig.mode, newTarget, false);
  rDraft.pass = orig.pass;

  const edits = new Map();
  const overwritten = orig.mode === 'amend' && node.children ? new Set() : null;

  for (const { seg: origSeg, slots } of orig.calls) {
    const seg = pickSegment(newTarget, rDraft, origSeg.site, origSeg.keyed, origSeg.key);
    appendSegment(rDraft, seg);
    for (let i = 0; i < seg.bindings.length; i++) {
      const oldB = origSeg.bindings[i], newB = seg.bindings[i], entry = slots[i];
      overwritten?.add(newB);
      const tag = entry?.[STAGED], childRef = tag === 'body' ? entry.ref : (tag ? entry.stageRef : null);
      if (!childRef) { edits.set(newB, entry); continue; }
      const cn = byRef.get(childRef);
      if (cn?.incoming && cn.parentNode === node && cn.anchor === oldB) cn.anchor = newB;
      else edits.set(newB, CLEAR);
    }
  }

  node.draft = rDraft;
  node.edits = edits.size ? edits : null;
  if (overwritten) {
    node.children = node.children.filter((c) => c.incoming || !overwritten.has(c.anchor));
    if (!node.children.length) node.children = null;
  }
}

// Pass 1 (DOM-free, non-mutating on existing state): resolve winners, tentative replays, and cycles.
function planCommit(rootRef) {
  const rootTarget = rootRef.target;
  if (!rootTarget?.anchor || rootTarget.owner !== rootRef)
    throw new Error('temtie/core: cannot commit an unanchored capture');

  const makeNode = (ref, anchor, parentNode, incoming, claimNext) => ({
    ref, target: null, anchor, parentNode, incoming, claimNext,
    draft: null, edits: null, children: null,
  });

  const seeded = new Map(); // tentative ref → won target whose surviving children must join Pass 1A
  const blocked = new Set();

  plan: for (;;) {
    // Pass 1A: walk planned refs (last-hole-wins per ref) and record committed targets claimed by their owner.
    const rootNode = makeNode(rootRef, rootTarget.anchor, null, null, UNSET);
    const byRef = new Map([[rootRef, rootNode]]);
    const queue = [rootNode];
    const claimedTargets = new Set();

    const attachRef = (ref, anchor, parentNode, incoming, claimNext) => {
      let childNode = byRef.get(ref);
      if (childNode) {
        if (!incoming) return;
        for (let p = parentNode; p; p = p.parentNode)
          if (p === childNode) throw new Error(CYCLE_ERR);
        if (childNode.incoming && childNode.anchor !== anchor)
          (childNode.parentNode.edits ??= new Map()).set(childNode.anchor, CLEAR);
        childNode.anchor = anchor;
        childNode.parentNode = parentNode;
        childNode.incoming = incoming;
        childNode.claimNext = claimNext;
        return;
      }
      childNode = makeNode(ref, anchor, parentNode, incoming, claimNext);
      byRef.set(ref, childNode);
      queue.push(childNode);
    };

    for (let i = 0; i < queue.length; i++) {
      const node = queue[i], ref = node.ref, draft = ref.draft;
      node.draft = draft;
      const owned = ref.target && ref.target.owner === ref ? ref.target : null;
      if (owned) claimedTargets.add(owned);
      const baseTarget = owned ?? seeded.get(ref) ?? null;
      if (baseTarget?.children.size) {
        let keepMark = 0;
        if (draft && draft.mode !== 'amend') {
          keepMark = ++PASS;
          for (const seg of nextListOf(draft, baseTarget.committed)) seg.keepPass = keepMark;
        }
        for (const child of baseTarget.children) {
          if (!draft || ((draft.mode === 'amend' || child.anchor.seg.keepPass === keepMark) && !draft.edits?.has(child.anchor)))
            if (child.owner) attachRef(child.owner, child.anchor, node, null, UNSET);
        }
      }
      if (!draft?.edits) continue;
      const edits = node.edits = new Map(draft.edits);
      for (const [binding, entry] of edits) {
        const tag = entry?.[STAGED];
        if (tag === 'body') { edits.delete(binding); attachRef(entry.ref, binding, node, 'body', UNSET); }
        else if (tag && entry.stageRef) { edits.delete(binding); attachRef(entry.stageRef, binding, node, entry.claim, entry.next); }
      }
    }

    for (let k = 1; k < queue.length; k++)
      (queue[k].parentNode.children ??= []).push(queue[k]);

    // Pass 1B: top-down target resolution, tentative draft replay on mismatch, and ancestor cycle checks.
    const wonTargets = new Set();
    const liveTargets = new Set();
    const ancestors = new Set();
    for (let t = rootTarget.parent; t; t = t.parent) ancestors.add(t);
    const committedRefs = [];
    const resolveStack = [rootNode];

    while (resolveStack.length) {
      const node = resolveStack.pop();
      if (node.leave) { ancestors.delete(node.leave); continue; }
      const ref = node.ref, anchor = node.anchor, parentTarget = node.parentNode?.target ?? rootTarget.parent;
      committedRefs.push(ref);

      if (ref.target && ref.target.owner === ref) {
        node.target = ref.target;
      } else {
        const occ = anchor.occupant;
        const occBody = ref.claim
          ? (occ?.kind === 'instance' && occ.spec === ref.claim.spec ? occ.body : null)
          : (occ?.kind === 'body' ? occ.body : null);
        const canWin = !!(occBody && !claimedTargets.has(occBody) && !wonTargets.has(occBody) && !blocked.has(occBody));
        if (canWin && occBody.children.size && (!node.draft || node.draft.mode === 'amend') && seeded.get(ref) !== occBody) {
          seeded.set(ref, occBody);
          continue plan;
        }
        node.target = canWin ? occBody : makeTarget(parentTarget.proto);
        if (seeded.has(ref) && node.target !== seeded.get(ref)) {
          blocked.add(seeded.get(ref));
          seeded.delete(ref);
          continue plan;
        }
        if (canWin) wonTargets.add(occBody);
        if (ref.target !== node.target || (node.draft && node.draft.baseRev !== node.target.rev))
          replayDraft(node, node.target, byRef);
      }

      if (node.incoming && ancestors.has(node.target)) throw new Error(CYCLE_ERR);
      if (node.incoming === 'body') node.incoming = { kind: 'body', body: node.target };

      liveTargets.add(node.target);
      if (node.children) {
        ancestors.add(node.target);
        resolveStack.push({ leave: node.target });
        for (let i = node.children.length - 1; i >= 0; i--) resolveStack.push(node.children[i]);
      }
    }

    return { rootNode, liveTargets, committedRefs };
  }
}

function inPlace(anchor, seg, prevEnd) {
  const builder = seg.builder, after = prevEnd ?? anchor.dest.after?.(anchor, builder);
  return after
    ? builder.prev(seg.start) === after
    : builder.parent(seg.start) === anchor.dest.container(anchor);
}

const needsPlace = (target, anchor) =>
  target.anchor !== anchor
  || (target.committed.length > 0 && (target.committed[0].parked !== null || !inPlace(anchor, target.committed[0], null)));

function parkSegs(target) {
  for (let i = target.committed.length - 1; i >= 0; i--) {
    const seg = target.committed[i];
    if (!seg.parked && seg.builder.parent(seg.start))
      seg.parked = seg.builder.extract(seg.start, seg.end);
  }
}

function evictSegs(initial, liveTargets, applied) {
  if (!initial.length) return;
  const segs = initial.slice();
  for (let i = 0; i < segs.length; i++) {
    for (const binding of segs[i].bindings) {
      const occ = binding.occupant;
      if (!occ) continue;
      binding.occupant = null;
      noteLeaving(occ, applied);
      if (!occ.body) continue;
      if (liveTargets?.has(occ.body)) parkSegs(occ.body);
      else for (const s of occ.body.committed) segs.push(s);
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (!seg.parked && seg.builder.parent(seg.start)) seg.builder.remove(seg.start, seg.end);
    seg.parked = null;
  }
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

function vacateBinding(binding, occ, nextKind, liveTargets, applied) {
  if (occ.kind === 'plain') {
    if (nextKind !== 'plain') { occ.prev = UNSET; binding.dest.clear(binding); }
    return;
  }
  binding.occupant = null;
  noteLeaving(occ, applied);
  if (occ.kind === 'instance' && occ.usedHole && nextKind !== 'plain') binding.dest.clear(binding);
  if (!occ.body) return;
  if (liveTargets?.has(occ.body)) parkSegs(occ.body);
  else evictSegs(occ.body.committed, liveTargets, applied);
}

function setOccupant(binding, next, liveTargets, applied) {
  const cur = binding.occupant;
  if (sameOccupant(cur, next)) return cur;
  if (cur) vacateBinding(binding, cur, next?.kind ?? null, liveTargets, applied);
  binding.occupant = next;
  if (next?.kind === 'instance') next.binding = binding;
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: next });
  return next;
}

function enqueueCommit(claim, next, applied) {
  claim.staged = next;
  if (commitOf(claim.spec)) applied.commits.push({ claim, next });
}

function bindTarget(target, anchor, parent, incoming) {
  if (target.parent && target.parent !== parent) target.parent.children.delete(target);
  target.anchor = anchor;
  target.parent = parent;
  parent?.children.add(target);
  if (incoming) {
    setOccupant(anchor, incoming, null, null);
    if (incoming.kind === 'instance') incoming.body = target;
  }
}

function reconcileSegments(target, anchor, draft, liveTargets, applied) {
  const committed = target.committed;
  const nextList = nextListOf(draft, committed);
  if (nextList === committed) {
    if (needsPlace(target, anchor)) placeChain(target, anchor, nextList);
    return committed;
  }

  if (draft.mode !== 'amend') {
    const mark = ++PASS;
    for (const seg of nextList) seg.keepPass = mark;
    let order = 0;
    for (const seg of committed) {
      if (seg.keepPass === mark) { seg.oldIndex = order++; continue; }
      debug.enabled && debug.emit({ type: 'drop', target, segment: seg });
      pruneSeg(target, seg);
      evictSegs([seg], liveTargets, applied);
    }
    if (target.anchor === anchor) {
      const keepMark = markKeepSet(nextList);
      if (keepMark) {
        // extract non-LIS moved segments so inPlace() keeps the LIS untouched
        for (const seg of nextList)
          if (!seg.parked && seg.keepPass !== keepMark && seg.builder.parent(seg.start))
            seg.parked = seg.builder.extract(seg.start, seg.end);
      }
    }
  }

  placeChain(target, anchor, nextList);
  return nextList;
}

function indexCreated(target, created) {
  for (const seg of created) {
    let bucket = target.buckets.get(seg.site);
    if (!bucket) target.buckets.set(seg.site, bucket = { byIndex: [], byKey: new Map() });
    if (seg.keyed) bucket.byKey.set(seg.key, seg);
    else bucket.byIndex[seg.index] = seg;
  }
}

function applyEdits(edits, liveTargets, applied) {
  for (const [binding, entry] of edits) {
    if (entry === CLEAR) {
      setOccupant(binding, null, liveTargets, applied);
      continue;
    }
    if (entry?.[STAGED]) {
      setOccupant(binding, entry.claim, liveTargets, applied);
      enqueueCommit(entry.claim, entry.next, applied);
      continue;
    }
    const occ = binding.occupant?.kind === 'plain'
      ? binding.occupant
      : setOccupant(binding, { kind: 'plain', prev: UNSET }, liveTargets, applied);
    if (same(occ.prev, entry)) continue;
    occ.prev = UNSET;
    writeHole(binding, entry);
    occ.prev = entry;
  }
}

function applyOne(node, liveTargets, applied) {
  const { ref, target, anchor, incoming, draft, edits } = node;
  const parent = node.parentNode ? node.parentNode.target : target.parent;

  if (target.owner !== ref) {
    if (target.owner) releaseOwner(target.owner);
    target.owner = ref;
    setTarget(ref, target);
  }

  if (incoming && !sameOccupant(anchor.occupant, incoming)) {
    const cur = anchor.occupant;
    if (cur) {
      if (cur.body === target) noteLeaving(cur, applied);
      else vacateBinding(anchor, cur, incoming.kind, liveTargets, applied);
      anchor.occupant = null;
    }
  }
  if (target.anchor && target.anchor !== anchor) {
    const host = target.anchor;
    if (host.occupant?.body === target) { noteLeaving(host.occupant, applied); host.occupant = null; }
    host.dest.vacate?.(host);
  }

  if (!draft) {
    if (needsPlace(target, anchor)) {
      settleSpan(target, 'place', 0, () => {
        placeChain(target, anchor, target.committed);
        if (target.committed.length) deliver(target, anchor);
      });
    }
    bindTarget(target, anchor, parent, incoming);
    return;
  }

  settleSpan(target, 'flush', draft.pass, () => {
    const nextList = reconcileSegments(target, anchor, draft, liveTargets, applied);
    bindTarget(target, anchor, parent, incoming);
    target.committed = nextList;
    target.rev++;
    if (draft.created) indexCreated(target, draft.created);
    if (edits) applyEdits(edits, liveTargets, applied);
    deliver(target, anchor);
  });
}

function applyPlan(rootNode, liveTargets, applied) {
  const stack = [rootNode];
  while (stack.length) {
    const item = stack.pop();
    if (item.post) { enqueueCommit(item.claim, item.next, applied); continue; }
    applyOne(item, liveTargets, applied);
    if (item.incoming?.kind === 'instance')
      stack.push({ post: true, claim: item.incoming, next: item.claimNext });
    const children = item.children;
    if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

function pruneSeg(target, seg) {
  const bucket = target.buckets.get(seg.site);
  if (!bucket) return;
  if (seg.keyed) { if (bucket.byKey.get(seg.key) === seg) bucket.byKey.delete(seg.key); }
  else if (bucket.byIndex[seg.index] === seg) {
    bucket.byIndex[seg.index] = undefined;
    while (bucket.byIndex.length && !bucket.byIndex[bucket.byIndex.length - 1]) bucket.byIndex.pop();
  }
  if (!bucket.byKey.size && !bucket.byIndex.length) target.buckets.delete(seg.site);
}
