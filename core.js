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

const stageOf = (spec) => (typeof spec === 'function' ? spec : spec.stage);
const commitOf = (spec) => (typeof spec === 'function' ? null : spec.commit);
const releaseOf = (spec) => (typeof spec === 'function' ? null : spec.release);

function assertCanStage(op) {
  if (PHASE === APPLY) throw new Error(`temtie/core: cannot ${op} while a commit is applying`);
}

function assertNotStaging(ref) {
  if (STAGING.has(ref)) throw new Error('temtie/core: cannot mutate a target while staging its own template');
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
  commitRef(refOf(inst, 'commit'));
}

/** @type {Discard} */
export function discard(inst) {
  assertCanStage('discard()');
  const ref = refOf(inst, 'discard');
  assertNotStaging(ref);
  if (!ref.draft) return;
  const draft = ref.draft;
  // explicit discard(child) keeps active parent drafts awaiting so child retains its slot until parent commits/discards
  if (draft.parents) {
    for (const p of draft.parents) {
      p.owned?.delete(draft);
      addAwait(p, ref);
    }
    draft.parents = null;
  }
  discardDraft(draft);
  debug.enabled && debug.emit({ type: 'call', target: ref.target, pass: ++PASS, via: 'discard' });
}

/** @type {Reset} */
export function reset(inst) {
  assertCanStage('reset()');
  const ref = refOf(inst, 'reset');
  assertNotStaging(ref);
  if (ref.target) beginDraft(ref, 'replace', 'reset');
}

/** @type {Amend} */
export function amend(inst) {
  assertCanStage('amend()');
  const ref = refOf(inst, 'amend');
  assertNotStaging(ref);
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
  const ref = { inst: Object.create(target ? target.proto : null), target, draft: null, awaiting: null, claim };
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

function detachRef(ref) {
  if (!ref.target || isOwnedAnchored(ref)) return;
  if (ref.target.owner === ref) ref.target.owner = null;
  ref.target = null;
  Object.setPrototypeOf(ref.inst, null);
}

const dropFrom = (set, key, self) => {
  if (set) for (const x of set) x[key]?.delete(self);
};

function clearAwaiting(ref) {
  dropFrom(ref.awaiting, 'awaiting', ref);
  ref.awaiting = null;
}

function releaseOwner(ref) {
  if (ref.draft) discardDraft(ref.draft);
  clearAwaiting(ref);
  ref.target = null;
  Object.setPrototypeOf(ref.inst, null);
}

function addAwait(parentDraft, childRef) {
  (parentDraft.awaiting ??= new Set()).add(childRef);
  (childRef.awaiting ??= new Set()).add(parentDraft);
}

function hasAncestorDraft(draft, target) {
  const seen = new Set([draft]), stack = [draft];
  for (let i = 0; i < stack.length; i++) {
    const cur = stack[i];
    if (cur === target) return true;
    if (cur.parents) for (const p of cur.parents) if (!seen.has(p)) { seen.add(p); stack.push(p); }
  }
  return false;
}

function addOwned(parentDraft, childDraft) {
  if (parentDraft === childDraft || (childDraft.owned?.size && hasAncestorDraft(parentDraft, childDraft))) return;
  (parentDraft.owned ??= new Set()).add(childDraft);
  (childDraft.parents ??= new Set()).add(parentDraft);
}

function linkChild(parentDraft, childRef) {
  if (parentDraft.ref === childRef) return;
  const childDraft = childRef.draft;
  if (!childDraft) {
    if (!isOwnedAnchored(childRef) || childRef.target.parent === parentDraft.ref.target)
      addAwait(parentDraft, childRef);
  } else if (!isOwnedAnchored(childRef) || childDraft.parents?.size) {
    addOwned(parentDraft, childDraft);
  }
}

function unlinkDraft(draft) {
  dropFrom(draft.parents, 'owned', draft);
  dropFrom(draft.awaiting, 'awaiting', draft);
  dropFrom(draft.owned, 'parents', draft);
  draft.parents = draft.awaiting = draft.owned = null;
  if (draft.ref.draft === draft) draft.ref.draft = null;
}

function discardDraft(rootDraft) {
  const queue = [rootDraft];
  for (let i = 0; i < queue.length; i++) {
    const d = queue[i];
    if (d.ref.draft === d) d.ref.draft = null;
    dropFrom(d.parents, 'owned', d);
    d.parents = null;
    if (d.awaiting) {
      for (const child of d.awaiting) {
        child.awaiting?.delete(d);
        if (!child.awaiting?.size && !child.draft) detachRef(child);
      }
      d.awaiting = null;
    }
    if (d.owned) {
      for (const childDraft of d.owned) {
        childDraft.parents?.delete(d);
        if (!childDraft.parents?.size) {
          if (childDraft.ref.draft === childDraft) queue.push(childDraft);
          else if (!childDraft.ref.awaiting?.size && !childDraft.ref.draft) detachRef(childDraft.ref);
        }
      }
      d.owned = null;
    }
    if (!d.ref.awaiting?.size && !d.ref.draft) detachRef(d.ref);
  }
}

function makeDraft(ref, mode, target = ref.target) {
  const tentative = !!(target && target.owner !== ref);
  return {
    ref, mode, pass: ++PASS,
    base: target ? target.committed : EMPTY_LIST,
    baseRev: target ? target.rev : 0,
    tentative, matched: 0, list: null, edits: null,
    used: null, created: null, seenKeys: null,
    owned: null, awaiting: null, parents: null,
    calls: tentative ? [] : null,
  };
}

function beginDraft(ref, mode, via) {
  const prev = ref.draft;
  const draft = ref.draft = makeDraft(ref, mode);
  if (prev) {
    if (prev.parents?.size) {
      for (const p of prev.parents) {
        p.owned?.delete(prev);
        addOwned(p, draft);
      }
      prev.parents = null;
    }
    discardDraft(prev);
  }
  if (ref.awaiting?.size) {
    for (const p of ref.awaiting) {
      p.awaiting?.delete(ref);
      addOwned(p, draft);
    }
    ref.awaiting = null;
  }
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

function makeChannel(builder) {
  return function channel(strings, ...values) {
    assertCanStage('stage templates');
    const ref = this[PRIVATE];
    assertNotStaging(ref);
    if (!ref.target) throw new Error('temtie/core: cannot stage into a detached capture');
    const draft = ref.draft ?? beginDraft(ref, 'replace', 'render');
    const site = compile(builder, strings, ref.target, draft.pass);
    recordSite(ref, draft, site, values);
  };
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

function recordSite(ref, draft, site, values) {
  const target = ref.target,
    template = site.template,
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
    const child = occ?.kind === 'body' ? occ.body : makeTarget(parentTarget.proto, childRef);
    childRef.target = child;
    Object.setPrototypeOf(childRef.inst, child.proto);
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
    stageFn = stageOf(spec);

  let claim, stageRef = null;
  if (reused) {
    claim = cur;
    stageRef = claim.ref;
  } else {
    claim = {
      kind: 'instance', spec, staged: UNSET, committed: UNSET,
      ref: null, body: null, alive: true, usedHole: false, handle: null,
      binding: null, owner: parentTarget,
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

const handleOf = (claim) => claim.handle ??= makeHandle(claim);

function makeHandle(claim) {
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
  return handle;
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

const pushAll = (dst, src) => { for (const item of src) dst.push(item); };

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

const nextListOf = (draft, committed) => (draft.mode === 'amend'
  ? (draft.created ? committed.concat(draft.created) : committed)
  : (draft.list ?? (draft.base === committed && draft.matched === committed.length
    ? committed
    : draft.base.slice(0, draft.matched))));

function noteLeaving(occ, applied) {
  if (occ.kind === 'body') applied.leaving.push(occ.body);
  else if (occ.kind === 'instance') {
    applied.ended.push(occ);
    if (occ.body) applied.leaving.push(occ.body);
  }
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
    const releaseFn = releaseOf(claim.spec);
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
  const rDraft = makeDraft(node.ref, orig.mode, newTarget);
  rDraft.pass = orig.pass;
  rDraft.tentative = false;
  rDraft.calls = null;

  const edits = new Map();
  const claims = [];
  const overwritten = orig.mode === 'amend' && node.children ? new Set() : null;

  for (const { seg: origSeg, slots } of orig.calls) {
    const seg = pickSegment(newTarget, rDraft, origSeg.site, origSeg.keyed, origSeg.key);
    appendSegment(rDraft, seg);
    for (let i = 0; i < seg.bindings.length; i++) {
      const oldB = origSeg.bindings[i], newB = seg.bindings[i], entry = slots[i];
      overwritten?.add(newB);
      const tag = entry?.[STAGED];
      if (!tag) { edits.set(newB, entry); continue; }
      const childRef = tag === 'body' ? entry.ref : entry.stageRef;
      if (tag === 'claim') entry.claim.owner = newTarget;
      if (!childRef) { claims.push([newB, entry.claim, entry.next]); continue; }
      const cn = byRef.get(childRef);
      if (cn?.ownerNode === node && cn.anchor === oldB) cn.anchor = newB;
      else edits.set(newB, CLEAR);
    }
  }

  node.draft = rDraft;
  node.edits = edits.size ? edits : null;
  node.claims = claims.length ? claims : null;
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
    ref, target: null, anchor, parentNode, ownerNode: null,
    incoming, incomingOcc: null, claimNext, takeOwner: false,
    draft: null, edits: null, claims: null, children: null,
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
          if (p === childNode)
            throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
        if (childNode.ownerNode && childNode.anchor !== anchor)
          (childNode.ownerNode.edits ??= new Map()).set(childNode.anchor, CLEAR);
        childNode.anchor = anchor;
        childNode.parentNode = parentNode;
        childNode.ownerNode = parentNode;
        childNode.incoming = incoming;
        childNode.claimNext = claimNext;
        return;
      }
      childNode = makeNode(ref, anchor, parentNode, incoming, claimNext);
      if (incoming) childNode.ownerNode = parentNode;
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
        if (!tag) continue;
        edits.delete(binding);
        if (tag === 'body') attachRef(entry.ref, binding, node, 'body', UNSET);
        else if (entry.stageRef) attachRef(entry.stageRef, binding, node, entry.claim, entry.next);
        else (node.claims ??= []).push([binding, entry.claim, entry.next]);
      }
    }

    for (let k = 1; k < queue.length; k++) {
      const node = queue[k];
      if (node.parentNode) (node.parentNode.children ??= []).push(node);
    }

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
        node.target = canWin ? occBody : makeTarget(parentTarget.proto, ref);
        if (seeded.has(ref) && node.target !== seeded.get(ref)) {
          blocked.add(seeded.get(ref));
          seeded.delete(ref);
          continue plan;
        }
        if (canWin) wonTargets.add(occBody);
        node.takeOwner = true;
        if (ref.target !== node.target || (node.draft && node.draft.baseRev !== node.target.rev))
          replayDraft(node, node.target, byRef);
      }

      if (node.incoming && ancestors.has(node.target))
        throw new Error('temtie/core: a target cannot be anchored beneath its descendant');

      node.incomingOcc = node.incoming === 'body'
        ? { kind: 'body', body: node.target }
        : (node.incoming || null);

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

function commitRef(rootRef) {
  const ev = debug.enabled && debug.emit({
    type: 'commit', target: rootRef.target, pass: rootRef.draft?.pass ?? 0,
    stack: debug.stacks ? new Error('commit') : undefined,
  });

  withCause(ev, () => {
    const plan = planCommit(rootRef);
    for (const ref of plan.committedRefs) {
      if (ref.draft) unlinkDraft(ref.draft);
      clearAwaiting(ref);
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
      if (applyFailed) { throwErrors(errors); return; }

      for (const { claim, next } of applied.commits) {
        if (!claim.alive) continue;
        const prev = claim.committed === UNSET ? undefined : claim.committed;
        tryStep(errors, () => {
          claim.spec.commit(handleOf(claim), prev, next);
          claim.committed = next;
        });
      }
      debug.enabled && ev && debug.emit({ type: 'settled', target: plan.rootNode.target });
      throwErrors(errors);
    } finally {
      PHASE = IDLE;
    }
  });
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
  if (!target.committed.length) return;
  const segs = target.committed.slice();
  for (let i = 0; i < segs.length; i++)
    for (const binding of segs[i].bindings)
      if (binding.occupant?.body?.committed.length) pushAll(segs, binding.occupant.body.committed);
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (!seg.parked && seg.builder.parent(seg.start))
      seg.parked = seg.builder.extract(seg.start, seg.end);
  }
}

function parkMoving(initial, liveTargets) {
  if (!liveTargets || !initial.length) return;
  const scan = initial.slice();
  for (let i = 0; i < scan.length; i++) {
    for (const binding of scan[i].bindings) {
      const body = binding.occupant?.body;
      if (!body) continue;
      if (liveTargets.has(body)) parkSegs(body);
      else pushAll(scan, body.committed);
    }
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
      if (occ.body && !liveTargets?.has(occ.body)) pushAll(segs, occ.body.committed);
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

function bindTarget(target, anchor, parent, incomingOcc) {
  if (target.parent && target.parent !== parent) target.parent.children.delete(target);
  target.anchor = anchor;
  target.parent = parent;
  parent?.children.add(target);
  if (incomingOcc) {
    const isClaim = incomingOcc.kind === 'instance';
    if (!sameOccupant(anchor.occupant, incomingOcc)) {
      anchor.occupant = incomingOcc;
      if (isClaim) incomingOcc.binding = anchor;
      debug.enabled && debug.emit({ type: 'claim', binding: anchor, occupant: incomingOcc });
    }
    if (isClaim) incomingOcc.body = target;
  }
}

function vacateBinding(binding, occ, nextKind, liveTargets, applied) {
  if (occ.kind === 'plain') {
    if (nextKind !== 'plain') {
      occ.prev = UNSET;
      if (binding.dest.kind === HOLE.SPREAD) writeSpread(binding, {});
      else binding.dest.clear?.(binding);
    }
    return;
  }
  if (occ.body) {
    if (liveTargets?.has(occ.body)) parkSegs(occ.body);
    else parkMoving(occ.body.committed, liveTargets);
  }
  binding.occupant = null;
  noteLeaving(occ, applied);
  if (occ.kind === 'instance' && occ.usedHole && nextKind !== 'plain') binding.dest.clear?.(binding);
  if (occ.body && !liveTargets?.has(occ.body)) evictSegs(occ.body.committed, liveTargets, applied);
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
      parkMoving([seg], liveTargets);
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
    const cur = binding.occupant;
    if (entry === CLEAR) {
      if (!cur) continue;
      vacateBinding(binding, cur, null, liveTargets, applied);
      binding.occupant = null;
      debug.enabled && debug.emit({ type: 'claim', binding, occupant: null });
      continue;
    }
    let occ = cur;
    if (occ?.kind !== 'plain') {
      if (occ) vacateBinding(binding, occ, 'plain', liveTargets, applied);
      occ = binding.occupant = { kind: 'plain', prev: UNSET };
      debug.enabled && debug.emit({ type: 'claim', binding, occupant: occ });
    } else {
      if (same(occ.prev, entry)) continue;
      occ.prev = UNSET;
    }
    writeHole(binding, entry);
    occ.prev = entry;
  }
}

function publishClaims(claims, liveTargets, applied) {
  for (const [binding, claim, next] of claims) {
    const cur = binding.occupant;
    if (cur !== claim) {
      if (cur) vacateBinding(binding, cur, 'instance', liveTargets, applied);
      binding.occupant = claim;
      claim.binding = binding;
      debug.enabled && debug.emit({ type: 'claim', binding, occupant: claim });
    }
    claim.staged = next;
    if (commitOf(claim.spec)) applied.commits.push({ claim, next });
  }
}

function applyOne(node, liveTargets, applied) {
  const { ref, target, anchor, incomingOcc, takeOwner, draft, edits, claims } = node;
  const parent = node.parentNode ? node.parentNode.target : target.parent;

  if (takeOwner) {
    const prevOwner = target.owner;
    if (prevOwner && prevOwner !== ref) releaseOwner(prevOwner);
    target.owner = ref;
    ref.target = target;
    Object.setPrototypeOf(ref.inst, target.proto);
  }

  if (incomingOcc && !sameOccupant(anchor.occupant, incomingOcc)) {
    const cur = anchor.occupant;
    if (cur) {
      if (cur.body === target) noteLeaving(cur, applied);
      else vacateBinding(anchor, cur, incomingOcc.kind, liveTargets, applied);
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
    bindTarget(target, anchor, parent, incomingOcc);
    return;
  }

  settleSpan(target, 'flush', draft.pass, () => {
    const nextList = reconcileSegments(target, anchor, draft, liveTargets, applied);
    bindTarget(target, anchor, parent, incomingOcc);
    target.committed = nextList;
    target.rev++;
    if (draft.created) indexCreated(target, draft.created);
    if (edits) applyEdits(edits, liveTargets, applied);
    deliver(target, anchor);
    if (claims) publishClaims(claims, liveTargets, applied);
  });
}

function applyPlan(rootNode, liveTargets, applied) {
  const stack = [rootNode];
  while (stack.length) {
    const item = stack.pop();
    if (item.post) {
      const { claim, next } = item;
      claim.staged = next;
      if (commitOf(claim.spec)) applied.commits.push({ claim, next });
      continue;
    }
    applyOne(item, liveTargets, applied);
    if (item.incomingOcc?.kind === 'instance')
      stack.push({ post: true, claim: item.incomingOcc, next: item.claimNext });
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
