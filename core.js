/* ꙋ temtie · core.js */
/// <reference path="./types.d.ts" />
/** @import { Mount, Capture, Commit, Discard, Reset, Amend } from 'temtie' */

import debug from './debug.js';

const PRIVATE = Symbol('temtie.private');
const VALUE = Symbol.for('temtie.value');
const UNSET = Symbol('temtie.unset');
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
const STAGING = new Set();

let PASS = 0;
let PHASE = IDLE;

const same = (a, b) => a === b || (a !== a && b !== b);
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;
const ownsTarget = (ref) => ref.target?.owner === ref;
const isOwnedAnchored = (ref) => ownsTarget(ref) && !!ref.target.anchor;
const coerceChild = (value) => (value == null || value === false ? '' : String(value));

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
  host.occupant = target.occ;

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
    for (const node of plan.steps) {
      if (node[STAGED]) continue;
      const ref = node.ref;
      clearOwners(ref);
      if (ref.draft) {
        dropFrom(ref.draft.children, 'owners', ref.draft);
        ref.draft.children = null;
        ref.draft = null;
      }
    }

    const applied = { leaving: [], releases: [], commits: [] };
    const errors = [];

    PHASE = APPLY;
    try {
      tryStep(errors, () => {
        for (const node of plan.steps) {
          if (node[STAGED]) enqueueCommit(node.claim, node.next, applied);
          else applyOne(node, plan.byRef, plan.liveTargets, applied);
        }
      });
      tryStep(errors, () => disposeBodies(applied, errors));
      PHASE = EFFECTS;
      const applyFailed = errors.length > 0;
      for (const claim of applied.releases) {
        debug.enabled && debug.emit({ type: 'end', binding: claim.binding, occupant: claim });
        tryStep(errors, () => {
          if (claim.spec.release && claim.committed !== UNSET)
            claim.spec.release(handleOf(claim), claim.committed);
        });
      }
      if (!applyFailed) {
        for (const { claim, next } of applied.commits) {
          if (!claim.alive) continue;
          const prev = claim.committed === UNSET ? undefined : claim.committed;
          tryStep(errors, () => {
            claim.spec.commit(handleOf(claim), prev, next);
            claim.committed = next;
          });
        }
        debug.enabled && ev && debug.emit({ type: 'settled', target: rootRef.target });
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

function makeRef(target) {
  const ref = { inst: Object.create(target ? target.proto : null), target, draft: null, owners: null, spec: null };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto, owner = null) {
  const target = {
    proto, owner, occ: null, anchor: null, parent: null, children: new Set(),
    committed: [], buckets: new Map(), rev: 0,
  };
  target.occ = { kind: 'body', body: target };
  return target;
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

function linkChild(parentDraft, childRef) {
  if (isOwnedAnchored(childRef) && !childRef.owners?.size
    && (childRef.draft || childRef.target.parent !== parentDraft.ref.target)) return;
  (parentDraft.children ??= new Set()).add(childRef);
  (childRef.owners ??= new Set()).add(parentDraft);
}

function discardDraft(rootDraft) {
  const dead = new Set([rootDraft]), refs = new Set([rootDraft.ref]), queue = [rootDraft];
  for (let i = 0; i < queue.length; i++) {
    const children = queue[i].children;
    if (!children) continue;
    for (const child of children) {
      refs.add(child);
      if (child.draft && !dead.has(child.draft)) {
        dead.add(child.draft);
        queue.push(child.draft);
      }
    }
  }
  const keep = [];
  for (const ref of refs)
    if (ref.owners) for (const p of ref.owners) if (!dead.has(p)) { keep.push(ref); break; }
  for (let i = 0; i < keep.length; i++) {
    const d = keep[i].draft;
    if (!d || d === rootDraft || !dead.has(d)) continue;
    dead.delete(d);
    if (d.children) for (const child of d.children) keep.push(child);
  }
  for (const d of dead) {
    if (d.ref.draft === d) d.ref.draft = null;
    dropFrom(d.children, 'owners', d);
    d.children = null;
  }
  for (const ref of refs) if (!ref.owners?.size && !ref.draft) detachRef(ref);
}

function makeDraft(ref, mode, target = ref.target, tentative = target.owner !== ref) {
  return {
    ref, mode, pass: ++PASS,
    base: target.committed, baseRev: target.rev,
    tentative, matched: 0, list: null, edits: null,
    used: null, created: null,
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
  let cursor = draft.used?.get(site);
  if (!cursor) (draft.used ??= new Map()).set(site, cursor = { index: 0, keys: null });
  const bucket = target.buckets.get(site), keyOrIndex = keyed ? key : cursor.index++;
  if (keyed) {
    const keys = cursor.keys ??= new Set();
    if (keys.has(key)) throw new Error('temtie/core: duplicate key in one pass');
    keys.add(key);
  }
  let seg = keyed ? bucket?.byKey.get(key) : bucket?.byIndex[keyOrIndex];
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
    try {
      withCause(ev, () => resolveSegment(ref, draft, seg, values));
    } finally {
      STAGING.delete(ref);
    }
    if (draft.calls) draft.calls.push(seg);
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
  let edits = draft.edits;
  const setSlot = (binding, entry) => (edits ??= draft.edits = new Map()).set(binding, entry);

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
        setSlot(binding, { [STAGED]: true, ref: childRef });
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
}

function resolveBody(parentTarget, draft, binding, childRef) {
  if (!binding.dest.container)
    throw new Error('temtie/core: a spread hole cannot host a target');
  if (childRef.spec)
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

  let claim = cur;
  if (!reused) {
    const body = stageFn && ((draft.tentative && sameSpec && cur.body) || makeTarget(parentTarget.proto));
    claim = Object.assign(body ? makeRef(body) : { inst: null }, {
      kind: 'instance', spec, staged: UNSET, committed: UNSET,
      body: null, alive: true, usedHole: false, handle: null, binding: null,
    });
    if (body && !body.owner) body.owner = claim;
  }
  if (stageFn) {
    linkChild(draft, claim);
    stageFn(claim.inst, reused && claim.staged !== UNSET ? claim.staged : undefined, raw);
  }
  return { [STAGED]: true, ref: stageFn ? claim : null, claim, next: raw };
}

function handleOf(claim) {
  if (claim.handle) return claim.handle;
  const binding = claim.binding, dest = binding.dest;
  const handle = {
    kind: dest.kind, builder: binding.builder, node: binding.node,
    marker: binding.marker, prop: binding.prop ?? null,
    target: claim.inst ?? null,
  };
  if (!claim.inst) {
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

const nextListOf = (draft, committed) => (draft.mode === 'amend'
  ? (draft.created ? committed.concat(draft.created) : committed)
  : (draft.list ?? (draft.base === committed && draft.matched === committed.length
    ? committed
    : draft.base.slice(0, draft.matched))));

function noteLeaving(occ, applied) {
  if (occ.body) applied.leaving.push(occ.body);
  if (occ.kind === 'instance' && occ.alive) {
    occ.alive = false;
    applied.releases.push(occ);
  }
}

function isLiveBody(body) {
  for (let cur = body; cur; cur = cur.parent) {
    if (!cur.anchor || cur.anchor.occupant?.body !== cur) return false;
    if (cur.anchor.dest.kind === ROOT) return true;
  }
  return false;
}

function disposeBodies(applied, errors) {
  const disposed = new Set(), roots = applied.leaving;
  for (let i = 0; i < roots.length; i++) {
    const body = roots[i];
    if (disposed.has(body) || isLiveBody(body)) continue;
    disposed.add(body);
    debug.enabled && debug.emit({ type: 'dispose', target: body });
    retireBody(body, null, applied, errors);
    if (body.anchor?.occupant?.body === body) body.anchor.occupant = null;
    body.parent?.children.delete(body);
    if (body.owner?.target === body) releaseOwner(body.owner);
    body.owner = null;
    body.buckets.clear();
    body.children.clear();
    body.anchor = body.parent = null;
  }
}

function replayDraft(node, target, byRef) {
  const orig = node.draft;
  if (!orig) return;
  const draft = makeDraft(node.ref, orig.mode, target, false);
  draft.pass = orig.pass;
  for (const prev of orig.calls) {
    const seg = pickSegment(target, draft, prev.site, prev.keyed, prev.key);
    appendSegment(draft, seg);
    for (let i = 0; i < seg.bindings.length; i++) {
      const old = prev.bindings[i], binding = seg.bindings[i], entry = orig.edits.get(old);
      (draft.edits ??= new Map()).set(binding, entry);
      const child = entry?.[STAGED] && entry.ref && byRef.get(entry.ref);
      if (child?.entry && child.parentNode === node && child.anchor === old) child.anchor = binding;
    }
  }
  node.draft = draft;
  if (orig.mode === 'amend' && node.children)
    node.children = node.children.filter(child => child.entry || !draft.edits?.has(child.anchor));
}

// Pass 1 (DOM-free, non-mutating on existing state): resolve winners, tentative replays, and cycles.
function planCommit(rootRef) {
  const rootTarget = rootRef.target;
  if (!rootTarget?.anchor || rootTarget.owner !== rootRef)
    throw new Error('temtie/core: cannot commit an unanchored capture');

  const makeNode = (ref, anchor, parentNode, entry = null) => ({
    ref, target: null, anchor, parentNode, entry, draft: null, children: null,
  });

  const seeded = new Map(); // tentative ref → won target whose surviving children must join Pass 1A
  const blocked = new Set();

  plan: for (;;) {
    // Pass 1A: walk planned refs (last-hole-wins per ref) and record committed targets claimed by their owner.
    const rootNode = makeNode(rootRef, rootTarget.anchor, null);
    const byRef = new Map([[rootRef, rootNode]]);
    const queue = [rootNode];
    const claimedTargets = new Set();

    const attachRef = (ref, anchor, parentNode, entry) => {
      let childNode = byRef.get(ref);
      if (childNode) {
        if (!entry) return;
        for (let p = parentNode; p; p = p.parentNode)
          if (p === childNode) throw new Error(CYCLE_ERR);
        childNode.anchor = anchor;
        childNode.parentNode = parentNode;
        childNode.entry = entry;
        return;
      }
      childNode = makeNode(ref, anchor, parentNode, entry);
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
            if (child.owner) attachRef(child.owner, child.anchor, node);
        }
      }
      if (draft?.edits) for (const [binding, entry] of draft.edits)
        if (entry?.[STAGED] && entry.ref) attachRef(entry.ref, binding, node, entry);
    }

    for (let k = 1; k < queue.length; k++)
      (queue[k].parentNode.children ??= []).push(queue[k]);

    // Pass 1B: top-down target resolution, tentative draft replay on mismatch, and ancestor cycle checks.
    const wonTargets = new Set();
    const liveTargets = new Set();
    const ancestors = new Set();
    for (let t = rootTarget.parent; t; t = t.parent) ancestors.add(t);
    const steps = [], resolveStack = [rootNode];
    while (resolveStack.length) {
      const node = resolveStack.pop();
      if (node.leave) {
        ancestors.delete(node.leave.target);
        if (node.leave.entry?.claim) steps.push(node.leave.entry);
        continue;
      }
      const ref = node.ref, anchor = node.anchor, parentTarget = node.parentNode?.target ?? rootTarget.parent;

      if (ref.target && ref.target.owner === ref) {
        node.target = ref.target;
      } else {
        const occ = anchor.occupant;
        const occBody = ref.spec
          ? (occ?.kind === 'instance' && occ.spec === ref.spec ? occ.body : null)
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

      if (node.entry && ancestors.has(node.target)) throw new Error(CYCLE_ERR);

      liveTargets.add(node.target);
      steps.push(node);
      if (node.children || node.entry?.claim) {
        ancestors.add(node.target);
        resolveStack.push({ leave: node });
        if (node.children) for (let i = node.children.length - 1; i >= 0; i--) resolveStack.push(node.children[i]);
      }
    }
    return { steps, byRef, liveTargets };
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

function retireBody(body, liveTargets, applied, errors) {
  if (!body.committed.length) return;
  const segs = body.committed;
  body.committed = [];
  evictSegs(segs, liveTargets, applied, errors);
}

function evictSegs(initial, liveTargets, applied, errors = null) {
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
      else {
        for (const s of occ.body.committed) segs.push(s);
        occ.body.committed = [];
      }
    }
  }
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i], parked = seg.parked;
    seg.parked = null;
    if (parked) continue;
    const remove = () => { if (seg.builder.parent(seg.start)) seg.builder.remove(seg.start, seg.end); };
    if (errors) tryStep(errors, remove);
    else remove();
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
  else retireBody(occ.body, liveTargets, applied);
}

function setOccupant(binding, next, liveTargets, applied) {
  const cur = binding.occupant;
  if (cur === next) return cur;
  if (cur) vacateBinding(binding, cur, next?.kind ?? null, liveTargets, applied);
  binding.occupant = next;
  if (next?.kind === 'instance') next.binding = binding;
  debug.enabled && debug.emit({ type: 'claim', binding, occupant: next });
  return next;
}

function enqueueCommit(claim, next, applied) {
  claim.staged = next;
  if (claim.spec.commit) applied.commits.push({ claim, next });
  else claim.committed = next;
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

function applyEdits(node, byRef, liveTargets, applied) {
  for (const [binding, entry] of node.draft.edits) {
    if (entry?.[STAGED]) {
      if (entry.ref) {
        const child = byRef.get(entry.ref);
        if (child.parentNode !== node || child.anchor !== binding)
          setOccupant(binding, null, liveTargets, applied);
      } else {
        setOccupant(binding, entry.claim, liveTargets, applied);
        enqueueCommit(entry.claim, entry.next, applied);
      }
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

function applyOne(node, byRef, liveTargets, applied) {
  const { ref, target, anchor, entry, draft } = node;
  const incoming = entry && (entry.claim ?? target.occ);
  const parent = node.parentNode ? node.parentNode.target : target.parent;

  if (target.owner !== ref) {
    if (target.owner) releaseOwner(target.owner);
    target.owner = ref;
    setTarget(ref, target);
  }

  if (incoming && anchor.occupant !== incoming) {
    const cur = anchor.occupant;
    if (cur) {
      if (cur.body === target) noteLeaving(cur, applied);
      else vacateBinding(anchor, cur, incoming.kind, liveTargets, applied);
      anchor.occupant = null;
    }
  }
  if (target.anchor && target.anchor !== anchor) {
    const host = target.anchor;
    if (host.occupant === target.occ) host.occupant = null;
    host.dest.vacate?.(host);
  }

  const moving = !draft && needsPlace(target, anchor);
  const ev = debug.enabled && (draft || moving) && debug.emit({
    type: draft ? 'flush' : 'place', target, pass: draft?.pass ?? 0,
  });
  withCause(ev, () => {
    const next = draft ? reconcileSegments(target, anchor, draft, liveTargets, applied) : target.committed;
    if (moving) {
      placeChain(target, anchor, next);
      if (next.length) deliver(target, anchor);
    }
    if (target.parent && target.parent !== parent) target.parent.children.delete(target);
    target.anchor = anchor;
    target.parent = parent;
    parent?.children.add(target);
    if (incoming) {
      if (incoming.kind === 'instance') incoming.body = target;
      setOccupant(anchor, incoming, null, null);
    }
    if (!draft) return;
    target.committed = next;
    target.rev++;
    if (draft.created) indexCreated(target, draft.created);
    if (draft.edits) applyEdits(node, byRef, liveTargets, applied);
    deliver(target, anchor);
  });
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
