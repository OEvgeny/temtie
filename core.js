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
  META: 'meta',
};
const HOLE = TEMPLATE_HOLE_TYPES;
const ACTIVE_CLAIMS = new Set();
const IDLE = 0, PLAN = 1, APPLY = 2;

let PASS = 0;
let PHASE = IDLE;
let PLAN_NODES = null;

// SameValueZero. NaN equals NaN.
const same = (a, b) => a === b || (a !== a && b !== b);

// undefined, null, true, and false are not keys. 0, '', and NaN are.
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;

const sameOccupant = (a, b) => a === b || (a?.kind === 'body' && b?.kind === 'body' && a.body === b.body);

const stageOf = (spec) => (typeof spec === 'function' ? spec : spec.stage);
const commitOf = (spec) => (typeof spec === 'function' ? null : spec.commit);
const releaseOf = (spec) => (typeof spec === 'function' ? null : spec.release);

/** @type {Mount} */
export function mount(container, builders) {
  if (!container) throw new Error(`temtie/core: expected container, got ${String(container)}`);
  if (!builders || typeof builders !== 'object' || typeof builders.compile === 'function' || !Object.keys(builders).length)
    throw new Error('temtie/core: mount() requires builders, e.g. mount(el, { html })');

  // a mounted root is a regular target seated in a uniform container host
  const host = { dest: DEST[ROOT], node: container, marker: null, builder: null, occupant: null };
  const target = makeTarget(makeProto(builders));
  target.anchor = host;
  host.occupant = { kind: 'body', body: target };

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
  if (!target?.staged) return;
  dropOpened(target, target.staged.pass);
  target.staged = null;
  debug.enabled && debug.emit({ type: 'call', target, pass: ++PASS, via: 'discard' });
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
  const ref = { inst: Object.create(target ? target.proto : claim?.owner.proto ?? null), target, claim };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto) {
  return {
    proto, anchor: null, parent: null, children: new Set(),
    committed: [], buckets: new Map(), ownerClaim: null, staged: null, dirty: false, pending: null,
  };
}

function refTarget(ref, materialize) {
  if (materialize && ref.claim?.usedHole)
    throw new Error('temtie/core: a contract that wrote through handle cannot also stage templates');
  if (!materialize || ref.target || !ref.claim) return ref.target;
  const target = ref.target = makeTarget(ref.claim.owner.proto);
  target.ownerClaim = ref.claim;
  return target;
}

function targetOf(inst, name, materialize = false) {
  const ref = inst?.[PRIVATE];
  if (!ref) throw new TypeError(`temtie/core: ${name}() expects a target from mount() or capture()`);
  return refTarget(ref, materialize);
}

function beginDraft(target, mode, via) {
  if (target.staged) dropOpened(target, target.staged.pass);
  const draft = target.staged = {
    mode, pass: ++PASS, base: target.committed,
    matched: 0, list: null, edits: null, used: null, created: null, createdKeys: null,
    children: null,
  };
  debug.enabled && debug.emit({ type: 'call', target, pass: draft.pass, via });
  return draft;
}

function dropOpened(root, since) {
  const seen = new Set([root]), queue = [root];
  const visit = (child) => {
    if (seen.has(child)) return;
    seen.add(child);
    queue.push(child);
  };
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    for (const child of cur.children) visit(child);
    if (cur.staged?.children)
      for (const child of cur.staged.children)
        if (!child.anchor && !(child.ownerClaim?.binding && child.ownerClaim.alive)) visit(child);
    if (cur !== root && cur.staged && cur.staged.pass > since) cur.staged = null;
  }
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

function isDroppedInPlan(target, seg) {
  const draft = PLAN_NODES?.get(target)?.draft;
  return !!draft && draft.mode !== 'amend' && !nextListOf(draft, target.committed).includes(seg);
}

function makeChannel(builder) {
  return function channel(strings, ...values) {
    const target = refTarget(this[PRIVATE], true);
    const draft = target.staged ?? beginDraft(target, 'replace', 'render');
    const site = compile(builder, strings, target, draft.pass);
    const template = site.template,
      key = template.keySlot >= 0 ? values[template.keySlot] : undefined,
      keyed = carriesIdentity(key),
      bucket = target.buckets.get(site);

    let seg, keyOrIndex, fresh = false;
    if (keyed) {
      keyOrIndex = key;
      seg = draft.createdKeys?.get(site)?.get(key);
      if (!seg) {
        seg = bucket?.byKey.get(key);
        if (seg && PLAN_NODES && isDroppedInPlan(target, seg)) seg = undefined;
      }
      if (seg?.seenPass === draft.pass)
        debug.enabled && debug.assert(false, 'temtie/core: duplicate key in one pass',
          { assert: 'duplicate-key', target, key, segment: seg });
    } else {
      keyOrIndex = draft.used?.get(site) ?? 0;
      (draft.used ??= new Map()).set(site, keyOrIndex + 1);
      seg = bucket?.byIndex[keyOrIndex];
      if (seg && PLAN_NODES && isDroppedInPlan(target, seg)) seg = undefined;
    }

    if (!seg) {
      seg = makeSegment(site, keyOrIndex, keyed);
      fresh = true;
      (draft.created ??= []).push(seg);
      if (keyed) {
        let byKey = draft.createdKeys?.get(site);
        if (!byKey) (draft.createdKeys ??= new Map()).set(site, byKey = new Map());
        byKey.set(key, seg);
      }
    }

    const ev = debug.enabled && debug.emit({
      type: 'stage', target, pass: draft.pass, segment: seg, template, fresh,
      key, stack: debug.stacks ? new Error('stage') : undefined,
    });

    if (seg.seenPass !== draft.pass) {
      seg.seenPass = draft.pass;
      if (draft.mode !== 'amend') {
        if (draft.list === null && draft.matched < draft.base.length && draft.base[draft.matched] === seg) {
          draft.matched++;
        } else {
          (draft.list ??= draft.base.slice(0, draft.matched)).push(seg);
        }
      }
    }

    withCause(ev, () => resolveSegment(target, draft, seg, values));
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
      container: null, occupant: null,
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
    clear: (binding) => binding.builder.setChild(binding.marker, null),
  },
  [HOLE.ATTR]: {
    kind: HOLE.ATTR,
    container: (binding) => binding.container ??= binding.builder.createRoot(),
    write: (binding, value) => binding.builder.setProp(binding.node, binding.prop, value),
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
    write: (binding, value) => writeSpread(binding, value == null ? {} : Object(value)),
  },
};

const carried = (body, seg, values) =>
  seg.bindings.some((binding) => values[binding.slot]?.[PRIVATE]?.target === body);

// Staging records inert data; contract stage() runs in Commit Pass 1 and commit()/release() in Pass 3.
function resolveSegment(target, draft, seg, values) {
  let edits = draft.edits;
  const setSlot = (binding, occ) => (edits ??= draft.edits = new Map()).set(binding, occ);

  for (const binding of seg.bindings) {
    const raw = values[binding.slot];
    if (raw !== null && (typeof raw === 'object' || typeof raw === 'function')) {
      const spec = raw[VALUE];
      if (spec !== undefined) {
        if ((typeof spec !== 'object' || spec === null) && typeof spec !== 'function')
          throw new TypeError('temtie/core: contract value requires a descriptor or function under Symbol.for("temtie.value")');
        if (!binding.dest.container)
          throw new Error('temtie/core: a spread hole cannot host a contract');
        setSlot(binding, { [STAGED]: 'value', spec, raw });
        continue;
      }
      if (raw[PRIVATE]) {
        setSlot(binding, { [STAGED]: 'body', kind: 'body', body: resolveBody(target, draft, seg, binding, raw[PRIVATE], values) });
        continue;
      }
    }
    const occ = binding.occupant;
    if (!PLAN_NODES && (occ ? (occ.kind === 'plain' && same(occ.prev, raw)) : !binding.dest.write)) {
      edits?.delete(binding);
      continue;
    }
    setSlot(binding, binding.dest.write ? raw : CLEAR);
  }
}

function resolveBody(parent, draft, seg, binding, ref, values) {
  if (binding.dest.instanceOnly) throw new Error('temtie/core: a meta hole cannot host a target');
  if (!binding.dest.container) throw new Error('temtie/core: a spread hole cannot host a target');

  const occ = binding.occupant;
  const child = refTarget(ref, !!ref.claim)
    ?? (occ?.kind === 'body' && !carried(occ.body, seg, values) && !draft.children?.has(occ.body) ? occ.body : null)
    ?? makeTarget(parent.proto);

  if (ref.target !== child) {
    ref.target = child;
    Object.setPrototypeOf(ref.inst, child.proto);
  }
  (draft.children ??= new Set()).add(child);
  return child;
}

const activeLazyBody = (claim) => (claim.ref?.target?.staged ? claim.ref.target : null);

function clearRange(binding, keepEnd = false) {
  const end = binding.end;
  if (!end) return;
  const builder = binding.builder, start = binding.marker, last = builder.prev(end);
  if (last && last !== start) {
    let first = last;
    for (let p = builder.prev(first); p && p !== start; p = builder.prev(first)) first = p;
    builder.remove(first, last);
  }
  if (!keepEnd) {
    if (builder.parent(end)) builder.remove(end, end);
    binding.end = null;
  }
}

const handleOf = (claim) => claim.handle ??= makeHandle(claim);

function assertIdle(op) {
  if (PHASE !== IDLE) throw new Error(`temtie/core: cannot ${op} while a commit is applying`);
}

function makeHandle(claim) {
  const binding = claim.binding, dest = binding.dest;
  const guard = (op) => {
    assertIdle(op);
    if (claim.body || activeLazyBody(claim))
      throw new Error(`temtie/core: a contract with staged content cannot also ${op}`);
  };
  const handle = {
    kind: dest.kind, builder: binding.builder, node: binding.node,
    marker: binding.marker, prop: binding.prop ?? null, name: binding.name,
    get target() { return (claim.ref ??= makeRef(null, claim)).inst; },
  };
  if (dest.write) {
    handle.set = (value) => {
      if (!claim.alive) return;
      guard('write through handle.set()');
      claim.usedHole = true;
      if (binding.end) clearRange(binding);
      writeHole(binding, value);
    };
  }
  if (dest.kind === HOLE.CHILD) {
    handle.range = () => {
      if (!claim.alive) return null;
      guard('claim handle.range()');
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
        clear: () => { if (claim.alive) { assertIdle('write through handle'); clearRange(binding, true); } },
      };
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

function runAll(fns, errors) {
  if (fns) for (const run of fns) tryStep(errors, run);
}

const pushAll = (dst, src) => { for (const item of src) dst.push(item); };

const removeSeg = (seg) => {
  if (seg.builder.parent(seg.start)) seg.builder.remove(seg.start, seg.end);
};

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

function noteLeaving(occ, applied) {
  if (occ.kind === 'body') applied.leaving.push(occ.body);
  else if (occ.kind === 'instance') {
    applied.ended.push(occ);
    const body = occ.body ?? occ.ref?.target;
    if (body) applied.leaving.push(body);
  }
}

function isLiveBody(body, stop = null) {
  for (let cur = body; cur; cur = cur.parent) {
    if (!cur.anchor || cur.anchor.occupant?.body !== cur) return false;
    if (cur === stop || (!stop && cur.anchor.dest.kind === ROOT)) return true;
  }
  return false;
}

function liveOwner(target, parent, fallback) {
  if (isLiveBody(target, fallback)) return target;
  for (let cur = parent; cur; cur = cur.parent)
    if (isLiveBody(cur, fallback)) return cur;
  return fallback;
}

const nextListOf = (draft, committed) => (draft.mode === 'amend'
  ? (draft.created ? committed.concat(draft.created) : committed)
  : (draft.list ?? (draft.base === committed && draft.matched === committed.length
    ? committed
    : draft.base.slice(0, draft.matched))));

function disposeBodies(roots, endedClaims, errors, owner = null, tried = null) {
  if (roots.length) {
    const disposed = new Set(), sink = { leaving: roots, ended: endedClaims, tried };
    for (let i = 0; i < roots.length; i++) {
      const body = roots[i];
      if (!body || disposed.has(body) || isLiveBody(body)) continue;
      disposed.add(body);
      debug.enabled && debug.emit({ type: 'dispose', target: body });
      const pendingOwner = liveOwner(body, body.parent ?? body.ownerClaim?.owner, owner);
      if (body.pending) { evictSegs(body.pending, pendingOwner, null, sink, errors); body.pending = null; }
      evictSegs(body.committed, pendingOwner, null, sink, errors);
      if (body.anchor?.occupant?.body === body) body.anchor.occupant = null;
      body.parent?.children.delete(body);
      body.committed = [];
      body.buckets.clear();
      body.children.clear();
      body.dirty = false;
      body.staged = body.anchor = body.parent = null;
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

const checkReentry = (bad) => {
  if (bad) throw new Error('temtie/core: cannot re-enter an active contract claim during commit');
};

function assertNoReentry(nodes) {
  for (const claim of ACTIVE_CLAIMS) {
    const bodyNode = claim.body && nodes.get(claim.body);
    checkReentry(bodyNode && bodyNode.anchor !== claim.binding);
    const ownerNode = nodes.get(claim.owner);
    if (ownerNode) {
      checkReentry(ownerNode.draft && ownerNode.draft.mode !== 'amend'
        && !nextListOf(ownerNode.draft, claim.owner.committed).includes(claim.binding.seg));
      continue;
    }
    for (let p = claim.owner.parent; p; p = p.parent) {
      if (nodes.has(p)) { checkReentry(true); break; }
    }
  }
}

function claimFor(target, binding, spec, raw) {
  const cur = binding.occupant;
  const claim = cur?.kind === 'instance' && cur.spec === spec && cur.alive ? cur : {
    kind: 'instance', spec, staged: UNSET, committed: UNSET, next: raw,
    ref: null, body: null, alive: true, usedHole: false, handle: null,
    binding: null, owner: target,
  };
  claim.next = raw;
  return claim;
}

// Pass 1 (DOM-free): detach drafts, expand pure contract stage(), resolve canonical ownership.
function planCommit(rootTarget, rootAnchor, rootParent) {
  const makeNode = (target, anchor, parent) => ({
    target, anchor, parent, ownerNode: null, incomingOcc: null,
    draft: null, edits: null, claims: null, children: null, placed: false,
  });
  const rootNode = makeNode(rootTarget, rootAnchor, rootParent);
  const nodes = new Map([[rootTarget, rootNode]]);
  const queue = [rootNode];

  const attachChild = (body, binding, parentNode, incomingOcc) => {
    const parent = parentNode.target;
    let childNode = nodes.get(body);
    if (incomingOcc && (childNode || (rootParent && body.children.size))) {
      for (let p = parent; p; p = nodes.get(p)?.parent ?? p.parent)
        if (p === body)
          throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
    }
    if (childNode) {
      if (!incomingOcc) return;
      if (childNode.ownerNode && childNode.anchor !== binding)
        (childNode.ownerNode.edits ??= new Map()).set(childNode.anchor, CLEAR);
      childNode.anchor = binding;
      childNode.parent = parent;
    } else {
      childNode = makeNode(body, binding, parent);
      nodes.set(body, childNode);
      queue.push(childNode);
    }
    if (incomingOcc) {
      childNode.ownerNode = parentNode;
      childNode.incomingOcc = incomingOcc;
    }
  };

  let i = 0, stagingRef = null;
  PLAN_NODES = nodes;
  try {
    for (; i < queue.length; i++) {
      const node = queue[i], target = node.target;

      // detach before any user hook runs: reentrant recording starts a separate draft
      const draft = target.staged;
      if (draft) { target.staged = null; node.draft = draft; }
      for (const child of target.children)
        if (!draft || ((draft.mode === 'amend' || child.anchor.seg.seenPass === draft.pass) && !draft.edits?.has(child.anchor)))
          attachChild(child, child.anchor, node, null);
      if (!draft?.edits) continue;

      const liveSegs = draft.mode === 'amend' && draft.base !== target.committed
        ? new Set(target.committed.concat(draft.created ?? [])) : null;
      const edits = node.edits = draft.edits;
      for (const [binding, entry] of edits) {
        if (liveSegs && !liveSegs.has(binding.seg)) { edits.delete(binding); continue; }
        checkReentry(ACTIVE_CLAIMS.size && ACTIVE_CLAIMS.has(binding.occupant));
        const tag = entry?.[STAGED];
        if (!tag) continue;
        edits.delete(binding);
        if (tag === 'body') { attachChild(entry.body, binding, node, entry); continue; }

        const claim = claimFor(target, binding, entry.spec, entry.raw);
        const stageFn = stageOf(entry.spec);
        if (stageFn) {
          const ref = stagingRef = claim.ref ??= makeRef(null, claim);
          stageFn(ref.inst, claim.staged === UNSET ? undefined : claim.staged, entry.raw);
          stagingRef = null;
        }
        const body = claim.body ?? activeLazyBody(claim);
        if (body) attachChild(body, binding, node, claim);
        else (node.claims ??= []).push([binding, claim]);
      }
    }

    if (ACTIVE_CLAIMS.size) assertNoReentry(nodes);
    for (let k = 1; k < queue.length; k++) {
      const node = queue[k], parentNode = node.parent && nodes.get(node.parent);
      if (parentNode) (parentNode.children ??= []).push(node);
    }
    return { rootNode, nodes, queue };
  } finally {
    PLAN_NODES = null;
    if (stagingRef?.target?.staged) stagingRef.target.staged = null;
    for (let j = i + 1; j < queue.length; j++) queue[j].target.staged = null;
  }
}

function recoverApply(queue, errors, rootTarget, applied) {
  for (const node of queue) {
    if (node.placed || !node.draft) continue;
    if (node.draft.created) {
      const owner = liveOwner(node.target, node.parent, rootTarget);
      for (const seg of node.draft.created)
        if (seg.parked === null) {
          const before = errors.length;
          tryStep(errors, () => removeSeg(seg));
          if (errors.length === before) seg.parked = UNSET;
          else { (applied.tried ??= new Set()).add(seg); queuePending(owner, seg); }
        }
    }
    dropOpened(node.target, node.draft.pass);
  }
}

function runCommits(commits, errors) {
  for (const { claim, next, isNew } of commits) {
    if (!claim.alive) continue;
    const prev = claim.committed === UNSET ? undefined : claim.committed;
    let ok = false;
    ACTIVE_CLAIMS.add(claim);
    try {
      claim.spec.commit(handleOf(claim), prev, next);
      claim.committed = next;
      ok = true;
    } catch (error) {
      errors.push(error);
    } finally {
      ACTIVE_CLAIMS.delete(claim);
    }
    if (ok || !isNew || claim.binding.occupant !== claim) continue;
    const binding = claim.binding;
    if (binding.end) tryStep(errors, () => clearRange(binding));
    if (claim.usedHole) tryStep(errors, () => binding.dest.clear?.(binding));
    binding.occupant = null;
    claim.committed = next;
    const body = claim.body ?? claim.ref?.target;
    claim.body = null;
    runAll(disposeBodies(body ? [body] : [], [claim], errors, claim.owner), errors);
  }
}

function commitTarget(rootTarget) {
  assertIdle('call commit()');
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
    const applied = { leaving: [], ended: [], commits: [], tried: null };
    const errors = [];
    let plan = null, releases = null;
    PHASE = PLAN;
    try {
      plan = planCommit(rootTarget, rootAnchor, rootParent);
      PHASE = APPLY;
      applyPlan(plan.rootNode, plan.nodes, applied);
    } catch (error) {
      if (!plan) throw error;
      errors.push(error);
      recoverApply(plan.queue, errors, rootTarget, applied);
    } finally {
      if (plan) releases = disposeBodies(applied.leaving, applied.ended, errors, rootTarget, applied.tried);
      PHASE = IDLE;
    }

    // Pass 3: Effects — Core is settled; release departing claims before post-order arriving commits
    const applyFailed = errors.length > 0;
    runAll(releases, errors);
    if (applyFailed) { throwErrors(errors); return; }

    runCommits(applied.commits, errors);
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
  target.dirty || target.anchor !== anchor
  || (target.committed.length > 0 && (target.committed[0].parked !== null || !inPlace(anchor, target.committed[0], null)));

function parkSegs(initial) {
  if (!initial.length) return;
  const segs = initial.slice();
  for (let i = 0; i < segs.length; i++) {
    for (const binding of segs[i].bindings) {
      const body = binding.occupant?.body;
      if (body) pushAll(segs, body.committed);
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (!seg.parked && seg.builder.parent(seg.start))
      seg.parked = seg.builder.extract(seg.start, seg.end);
  }
}

function queuePending(owner, seg) {
  const list = owner.pending ??= [];
  if (!list.includes(seg)) list.push(seg);
}

function finishEvict(seg) {
  if (seg.parked === UNSET) return;
  for (const binding of seg.bindings) if (binding.end) clearRange(binding);
  if (seg.parked === null) removeSeg(seg);
  seg.parked = UNSET;
}

function drainPending(target, applied) {
  const pending = target.pending;
  if (!pending) return;
  let i = 0;
  try {
    for (; i < pending.length; i++) finishEvict(pending[i]);
  } finally {
    if (i < pending.length) {
      (applied.tried ??= new Set()).add(pending[i]);
      target.pending = pending.slice(i);
    } else {
      target.pending = null;
    }
  }
}

function evictSegs(initial, owner, liveNodes, applied, errors) {
  if (!initial.length) return;
  const segs = initial.slice();
  for (let i = 0; i < segs.length; i++) {
    for (const binding of segs[i].bindings) {
      const occ = binding.occupant;
      if (!occ) continue;
      binding.occupant = null;
      noteLeaving(occ, applied);
      if (!occ.body) continue;
      if (liveNodes?.has(occ.body)) parkSegs(occ.body.committed);
      else if (liveNodes) pushAll(segs, occ.body.committed);
    }
  }
  let i = segs.length - 1;
  try {
    for (; i >= 0; i--) {
      const seg = segs[i];
      if (seg.parked === UNSET) continue;
      if (applied.tried?.has(seg)) {
        if (owner) queuePending(owner, seg);
        continue;
      }
      if (errors) {
        const before = errors.length;
        tryStep(errors, () => finishEvict(seg));
        if (errors.length > before) {
          (applied.tried ??= new Set()).add(seg);
          if (owner) queuePending(owner, seg);
        }
      } else {
        finishEvict(seg);
      }
    }
  } finally {
    if (i >= 0) {
      (applied.tried ??= new Set()).add(segs[i]);
      if (owner) for (let j = i; j >= 0; j--) if (segs[j].parked !== UNSET) queuePending(owner, segs[j]);
    }
  }
}

function vacateBody(body, owner, liveNodes, applied) {
  if (liveNodes.has(body)) parkSegs(body.committed);
  else evictSegs(body.committed, owner, liveNodes, applied, null);
}

function placeChain(target, anchor, list) {
  let prevEnd = null;
  for (const seg of list) {
    if (seg.parked || !inPlace(anchor, seg, prevEnd)) {
      const builder = seg.builder,
        after = prevEnd ?? anchor.dest.after?.(anchor, builder),
        container = anchor.dest.container(anchor);
      target.dirty = true;
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
  target.dirty = false;
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
  } else if (target.ownerClaim?.binding === anchor) {
    target.ownerClaim.body = target;
  }
}

function placeOne(target, anchor, parent, incomingOcc) {
  if (needsPlace(target, anchor)) {
    settleSpan(target, 'place', 0, () => {
      placeChain(target, anchor, target.committed);
      if (target.committed.length) deliver(target, anchor);
    });
  }
  bindTarget(target, anchor, parent, incomingOcc);
}

function vacateBinding(binding, occ, nextKind, owner, liveNodes, applied) {
  if (occ.kind === 'plain') {
    if (nextKind !== 'plain') {
      occ.prev = UNSET;
      if (binding.dest.kind === HOLE.SPREAD) writeSpread(binding, {});
      else binding.dest.clear?.(binding);
    }
    return;
  }
  binding.occupant = null;
  noteLeaving(occ, applied);
  if (occ.kind === 'instance') {
    if (binding.end) clearRange(binding);
    if (occ.usedHole && nextKind !== 'plain') binding.dest.clear?.(binding);
  }
  if (occ.body) vacateBody(occ.body, owner, liveNodes, applied);
}

function reconcileSegments(target, anchor, draft, liveNodes, applied) {
  const committed = target.committed;
  const nextList = nextListOf(draft, committed);
  if (nextList === committed) {
    if (needsPlace(target, anchor)) placeChain(target, anchor, nextList);
    return committed;
  }

  if (draft.mode !== 'amend') {
    const mark = ++PASS;
    for (const seg of nextList) seg.keepPass = mark;
    let order = 0, dropped = 0, idx = 0;
    try {
      for (; idx < committed.length; idx++) {
        const seg = committed[idx];
        if (seg.keepPass === mark) { seg.oldIndex = order++; continue; }
        dropped++;
        debug.enabled && debug.emit({ type: 'drop', target, segment: seg });
        pruneSeg(target, seg);
        evictSegs([seg], target, liveNodes, applied, null);
      }
    } finally {
      if (dropped) {
        const rem = [];
        for (let j = 0; j < committed.length; j++)
          if (committed[j].keepPass === mark || j > idx) rem.push(committed[j]);
        target.committed = rem;
      }
    }
    if (target.anchor === anchor && !target.dirty) {
      const keepMark = markKeepSet(nextList);
      if (keepMark) {
        target.dirty = true;
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

function applyEdits(target, edits, liveNodes, applied) {
  for (const [binding, entry] of edits) {
    const cur = binding.occupant;
    if (entry === CLEAR) {
      if (!cur) continue;
      vacateBinding(binding, cur, null, target, liveNodes, applied);
      binding.occupant = null;
      debug.enabled && debug.emit({ type: 'claim', binding, occupant: null });
      continue;
    }
    let occ = cur;
    if (occ?.kind !== 'plain') {
      if (occ) vacateBinding(binding, occ, 'plain', target, liveNodes, applied);
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

function publishClaims(target, claims, liveNodes, applied) {
  for (const [binding, claim] of claims) {
    const cur = binding.occupant, isNew = claim.binding === null;
    if (cur !== claim) {
      if (cur) vacateBinding(binding, cur, 'instance', target, liveNodes, applied);
      binding.occupant = claim;
      claim.binding = binding;
      debug.enabled && debug.emit({ type: 'claim', binding, occupant: claim });
    }
    claim.staged = claim.next;
    if (commitOf(claim.spec)) applied.commits.push({ claim, next: claim.next, isNew });
  }
}

function applyOne(node, liveNodes, applied) {
  const { target, anchor, parent, incomingOcc, draft, edits, claims } = node;

  if (incomingOcc && !sameOccupant(anchor.occupant, incomingOcc)) {
    if (anchor.occupant) vacateBinding(anchor, anchor.occupant, incomingOcc.kind, parent ?? target, liveNodes, applied);
    anchor.occupant = null;
  }
  if (target.anchor && target.anchor !== anchor) {
    const host = target.anchor;
    if (host.occupant?.body === target) { noteLeaving(host.occupant, applied); host.occupant = null; }
    host.dest.vacate?.(host);
  }
  if (target.pending) drainPending(target, applied);

  if (!draft) {
    placeOne(target, anchor, parent, incomingOcc);
    node.placed = true;
    return;
  }

  settleSpan(target, 'flush', draft.pass, () => {
    const nextList = reconcileSegments(target, anchor, draft, liveNodes, applied);
    bindTarget(target, anchor, parent, incomingOcc);
    target.committed = nextList;
    node.placed = true;
    if (draft.created) indexCreated(target, draft.created);
    if (edits) applyEdits(target, edits, liveNodes, applied);
    deliver(target, anchor);
    if (claims) publishClaims(target, claims, liveNodes, applied);
  });
}

function applyPlan(rootNode, liveNodes, applied) {
  const stack = [rootNode];
  while (stack.length) {
    const item = stack.pop();
    if (item.post) {
      // Post-order: body writes and all descendants succeeded — advance staged checkpoint & enqueue commit
      const { claim, isNew } = item;
      claim.staged = claim.next;
      if (commitOf(claim.spec)) applied.commits.push({ claim, next: claim.next, isNew });
      continue;
    }
    const incomingOcc = item.incomingOcc;
    const incomingIsNew = incomingOcc?.kind === 'instance' && incomingOcc.binding === null;
    applyOne(item, liveNodes, applied);
    if (incomingOcc?.kind === 'instance')
      stack.push({ post: true, claim: incomingOcc, isNew: incomingIsNew });
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
