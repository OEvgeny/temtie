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
const EMPTY_NODES = new Map();
const IDLE = 0, PLAN = 1, APPLY = 2;

let PASS = 0;
let PHASE = IDLE;

// SameValueZero. NaN equals NaN.
const same = (a, b) => a === b || (a !== a && b !== b);

// undefined, null, true, and false are not keys. 0, '', and NaN are.
const carriesIdentity = (key) => key !== undefined && key !== null && key !== true && key !== false;

const sameOccupant = (a, b) => a === b || (a?.kind === 'body' && b?.kind === 'body' && a.body === b.body);

const stageOf = (spec) => (typeof spec === 'function' ? spec : spec.stage);
const commitOf = (spec) => (typeof spec === 'function' ? null : spec.commit);
const releaseOf = (spec) => (typeof spec === 'function' ? null : spec.release);

/** @type {Mount} */
export function mount(container, { builders } = {}) {
  if (!container) throw new Error(`temtie/core: expected container, got ${String(container)}`);
  if (!builders || typeof builders !== 'object' || !Object.keys(builders).length)
    throw new Error('temtie/core: mount() requires builders, e.g. mount(el, { builders: { html } })');

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
  if (!target?.staged || target.staged.sealed) return;
  voidOpened(target, target.staged.pass);
  const pass = ++PASS;
  target.staged = { sealed: true, pass };
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
  const ref = { inst: Object.create(target ? target.proto : claim?.owner.proto ?? null), target, claim };
  Object.defineProperty(ref.inst, PRIVATE, { value: ref });
  return ref;
}

function makeTarget(proto) {
  return {
    proto, anchor: null, parent: null, children: new Set(),
    committed: [], buckets: new Map(), ownerClaim: null, staged: null,
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

const activeDraft = (target) =>
  target?.staged && !target.staged.sealed && !target.staged.voided ? target.staged : null;

function beginDraft(target, mode, via) {
  if (target.staged && !target.staged.sealed) voidOpened(target, target.staged.pass);
  const draft = target.staged = {
    mode, pass: ++PASS, base: target.committed,
    sealed: false, voided: false, matched: 0,
    list: null, edits: null, used: null, created: null, createdKeys: null,
    children: null, takenBodies: null,
  };
  debug.enabled && debug.emit({ type: 'call', target, pass: draft.pass, via });
  return draft;
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
    const target = refTarget(this[PRIVATE], true);
    const draft = activeDraft(target) ?? beginDraft(target, 'replace', 'render');
    const site = compile(builder, strings, target, draft.pass);
    const template = site.template,
      key = template.keySlot >= 0 ? values[template.keySlot] : undefined,
      keyed = carriesIdentity(key),
      bucket = target.buckets.get(site);

    let seg, keyOrIndex, fresh = false;
    if (keyed) {
      keyOrIndex = key;
      seg = draft.createdKeys?.get(site)?.get(key) ?? bucket?.byKey.get(key);
      if (seg?.seenPass === draft.pass)
        debug.enabled && debug.assert(false, 'temtie/core: duplicate key in one pass',
          { assert: 'duplicate-key', target, key, segment: seg });
    } else {
      keyOrIndex = draft.used?.get(site) ?? 0;
      (draft.used ??= new Map()).set(site, keyOrIndex + 1);
      seg = bucket?.byIndex[keyOrIndex];
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

function reaches(cur, goal, seen = new Set()) {
  if (cur === goal) return true;
  if (seen.has(cur)) return false;
  seen.add(cur);
  const staged = cur.staged, active = staged && !staged.sealed;
  if (active && staged.children) for (const child of staged.children) if (reaches(child, goal, seen)) return true;
  if (!active || staged.mode === 'amend') for (const child of cur.children) if (reaches(child, goal, seen)) return true;
  return false;
}

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
    if (occ ? (occ.kind === 'plain' && same(occ.prev, raw)) : !binding.dest.write) {
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

const activeLazyBody = (claim) => (activeDraft(claim.ref?.target) ? claim.ref.target : null);

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
  if (!fns) return;
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
      for (const seg of body.committed) dropSeg(seg, EMPTY_NODES, sink);
      if (body.anchor?.occupant?.body === body) body.anchor.occupant = null;
      body.parent?.children.delete(body);
      body.committed = [];
      body.buckets.clear();
      body.children.clear();
      body.staged = body.anchor = body.parent = null;
    }
  }
  if (!endedClaims.length) return null;
  const releases = [];
  for (const claim of endedClaims) {
    if (!claim.alive) continue;
    claim.alive = false;
    if (!claim.body && claim.ref?.target?.staged) claim.ref.target.staged = null;
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

// Pass 1 (DOM-free): detach drafts, expand pure contract stage(), resolve canonical ownership.
function planCommit(rootTarget, rootAnchor, rootParent) {
  const makeNode = (target, anchor, parent) => ({
    target, anchor, parent, ownerNode: null, incomingOcc: null,
    draft: null, sealed: false, edits: null, children: null, placed: false,
  });
  const rootNode = makeNode(rootTarget, rootAnchor, rootParent);
  const nodes = new Map([[rootTarget, rootNode]]);
  const queue = [rootNode];

  const attachChild = (body, binding, parentNode, incomingOcc) => {
    const parent = parentNode.target;
    if (incomingOcc) {
      for (let p = parent; p; p = nodes.get(p)?.parent ?? p.parent)
        if (p === body)
          throw new Error('temtie/core: a target cannot be anchored beneath its descendant');
    }
    let childNode = nodes.get(body);
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

  let i = 0;
  try {
    for (; i < queue.length; i++) {
      const node = queue[i], target = node.target;

      if (target.staged?.sealed) { node.sealed = true; continue; }
      if (!target.staged) {
        for (const child of target.children) attachChild(child, child.anchor, node, null);
        continue;
      }

      // detach before any user hook runs: reentrant recording starts a separate draft
      const draft = target.staged;
      target.staged = null;
      node.draft = draft;

      for (const child of target.children)
        if ((draft.mode === 'amend' || child.anchor.seg.seenPass === draft.pass) && !draft.edits?.has(child.anchor))
          attachChild(child, child.anchor, node, null);

      if (draft.edits) {
        const liveSegs = draft.mode === 'amend' && draft.base !== target.committed
          ? new Set(target.committed.concat(draft.created ?? [])) : null;
        const edits = node.edits = draft.edits;
        for (const [binding, entry] of edits) {
          if (liveSegs && !liveSegs.has(binding.seg)) { edits.delete(binding); continue; }
          const tag = entry?.[STAGED];
          if (!tag) continue;
          if (tag === 'body') {
            edits.delete(binding);
            attachChild(entry.body, binding, node, entry);
            continue;
          }
          const { spec, raw } = entry, cur = binding.occupant;
          const claim = cur?.kind === 'instance' && cur.spec === spec && cur.alive ? cur : {
            [STAGED]: 'instance', kind: 'instance', spec, staged: UNSET, committed: UNSET, next: raw,
            ref: null, body: null, alive: true, usedHole: false, handle: null,
            binding: null, owner: target,
          };
          claim.next = raw;
          const stageFn = stageOf(spec);
          if (stageFn) {
            const ref = claim.ref ??= makeRef(null, claim);
            try {
              stageFn(ref.inst, claim.staged === UNSET ? undefined : claim.staged, raw);
            } catch (error) {
              if (ref.target?.staged) ref.target.staged = null;
              throw error;
            }
          }
          const body = claim.body ?? activeLazyBody(claim);
          if (body) {
            edits.delete(binding);
            attachChild(body, binding, node, claim);
          } else {
            edits.set(binding, claim);
          }
        }
      }
    }

    for (let k = 1; k < queue.length; k++) {
      const node = queue[k], parentNode = node.parent && nodes.get(node.parent);
      if (parentNode) (parentNode.children ??= []).push(node);
    }

    return { rootNode, nodes, queue };
  } catch (error) {
    for (let j = i + 1; j < queue.length; j++) {
      const t = queue[j].target;
      if (t.staged && !t.staged.sealed) t.staged = null;
    }
    throw error;
  }
}

function commitTarget(rootTarget) {
  assertIdle('call commit()');
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
    const applied = { leaving: [], ended: [], commits: [] };
    let releases;
    PHASE = PLAN;
    try {
      const plan = planCommit(rootTarget, rootAnchor, rootParent);
      PHASE = APPLY;
      try {
        applyNode(plan.rootNode, plan.nodes, applied);
        releases = disposeBodies(applied.leaving, applied.ended);
      } catch (error) {
        PHASE = IDLE;
        for (const node of plan.queue) {
          if (!node.placed && node.draft?.created)
            for (const seg of node.draft.created)
              if (!seg.parked && seg.builder.parent(seg.start))
                try { seg.builder.remove(seg.start, seg.end); } catch {}
          if (!node.placed && node.draft) voidOpened(node.target, node.draft.pass);
        }
        const errors = [error];
        runAll(disposeBodies(applied.leaving, applied.ended), errors);
        throwErrors(errors);
      }
    } finally {
      PHASE = IDLE;
    }

    // Pass 3: Effects — Core is settled; release departing claims before post-order arriving commits
    const errors = [];
    runAll(releases, errors);

    for (const { claim, next, isNew } of applied.commits) {
      if (!claim.alive) continue;
      const prev = claim.committed === UNSET ? undefined : claim.committed;
      try {
        claim.spec.commit(handleOf(claim), prev, next);
        claim.committed = next;
      } catch (error) {
        errors.push(error);
        const binding = claim.binding;
        if (isNew && binding.occupant === claim) {
          if (binding.end) try { clearRange(binding); } catch {}
          if (claim.usedHole) try { binding.dest.clear?.(binding); } catch {}
          binding.occupant = null;
          claim.committed = next;
          const body = claim.body;
          claim.body = null;
          runAll(disposeBodies(body ? [body] : [], [claim]), errors);
        }
      }
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
  target.anchor !== anchor
  || (target.committed.length > 0 && (target.committed[0].parked !== null || !inPlace(anchor, target.committed[0], null)));

function parkSeg(seg, liftBodies = true) {
  if (liftBodies)
    for (const binding of seg.bindings) {
      const body = binding.occupant?.body;
      if (body) for (const s of body.committed) parkSeg(s, true);
    }
  if (!seg.parked && seg.builder.parent(seg.start))
    seg.parked = seg.builder.extract(seg.start, seg.end);
}

function vacateBody(body, liveNodes, applied) {
  if (liveNodes.has(body)) for (const s of body.committed) parkSeg(s, true);
  else for (const s of body.committed) dropSeg(s, liveNodes, applied);
}

function dropSeg(seg, liveNodes, applied) {
  for (const binding of seg.bindings) {
    if (binding.end) clearRange(binding);
    const occ = binding.occupant;
    if (occ) {
      binding.occupant = null;
      noteLeaving(occ, applied);
      if (occ.body) vacateBody(occ.body, liveNodes, applied);
    }
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
    if (isClaim) { incomingOcc.body = target; incomingOcc.staged = incomingOcc.next; }
  } else if (target.ownerClaim?.binding === anchor) {
    target.ownerClaim.body = target;
  }
}

function placeSubtree(target, anchor, parent, liveNodes, incomingOcc, recurse) {
  const moved = needsPlace(target, anchor);
  if (moved) {
    settleSpan(target, 'place', 0, () => {
      placeChain(target, anchor, target.committed);
      if (target.committed.length) deliver(target, anchor);
    });
  }
  bindTarget(target, anchor, parent, incomingOcc);
  if (moved && recurse) {
    for (const child of target.children) {
      const childNode = liveNodes.get(child);
      if (!childNode || childNode.parent === target)
        placeSubtree(child, child.anchor, target, liveNodes, null, true);
    }
  }
}

function vacateBinding(binding, occ, nextKind, liveNodes, applied) {
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
  if (occ.body) vacateBody(occ.body, liveNodes, applied);
}

function applyNode(node, liveNodes, applied) {
  const { target, anchor, parent, incomingOcc, draft, edits } = node;
  const incomingIsNew = incomingOcc?.kind === 'instance' && incomingOcc.binding === null;

  if (incomingOcc && !sameOccupant(anchor.occupant, incomingOcc)) {
    if (anchor.occupant) vacateBinding(anchor, anchor.occupant, incomingOcc.kind, liveNodes, applied);
    anchor.occupant = null;
  }

  if (target.anchor && target.anchor !== anchor) {
    const host = target.anchor;
    if (host.occupant?.body === target) {
      noteLeaving(host.occupant, applied);
      host.occupant = null;
    }
    host.dest.vacate?.(host);
  }

  if (!draft || node.sealed) {
    placeSubtree(target, anchor, parent, liveNodes, incomingOcc, node.sealed);
    node.placed = true;
    if (node.sealed) debug.enabled && debug.emit({ type: 'sealed', target, pass: target.staged.pass });
  } else {
    settleSpan(target, 'flush', draft.pass, () => {
      let committed = target.committed;
      const nextList = draft.mode === 'amend'
        ? (draft.created ? committed.concat(draft.created) : committed)
        : (draft.list ?? (draft.base === committed && draft.matched === committed.length
          ? committed
          : draft.base.slice(0, draft.matched)));

      if (draft.mode !== 'amend' && nextList !== committed) {
        const mark = ++PASS;
        for (const seg of nextList) seg.keepPass = mark;
        let anyDropped = false;
        for (const seg of committed) {
          if (seg.keepPass === mark) continue;
          anyDropped = true;
          debug.enabled && debug.emit({ type: 'drop', target, segment: seg });
          dropSeg(seg, liveNodes, applied);
          pruneSeg(target, seg);
        }
        if (anyDropped) committed = target.committed = committed.filter((seg) => seg.keepPass === mark);
      }

      if (nextList !== committed || needsPlace(target, anchor)) {
        if (draft.mode !== 'amend' && nextList !== committed && target.anchor === anchor) {
          const mark = ++PASS;
          markKeepSet(nextList, committed, mark);
          // reordered segments keep their hosted child bodies intact and move as one subtree
          for (const seg of nextList) if (!seg.parked && seg.keepPass !== mark) parkSeg(seg, false);
        }
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
        for (const [binding, entry] of edits) {
          if (entry?.[STAGED] === 'instance') { (claims ??= []).push([binding, entry]); continue; }
          const cur = binding.occupant;
          if (entry === CLEAR) {
            if (cur) vacateBinding(binding, cur, null, liveNodes, applied);
            binding.occupant = null;
            debug.enabled && debug.emit({ type: 'claim', binding, occupant: null });
            continue;
          }
          let occ = cur;
          if (occ?.kind !== 'plain') {
            if (occ) vacateBinding(binding, occ, 'plain', liveNodes, applied);
            occ = binding.occupant = { kind: 'plain', prev: UNSET };
            debug.enabled && debug.emit({ type: 'claim', binding, occupant: occ });
          } else {
            occ.prev = UNSET;
          }
          writeHole(binding, entry);
          occ.prev = entry;
        }
        if (claims) {
          for (const [binding, claim] of claims) {
            const cur = binding.occupant, isNew = claim.binding === null;
            if (cur !== claim) {
              if (cur) vacateBinding(binding, cur, 'instance', liveNodes, applied);
              binding.occupant = claim;
              claim.binding = binding;
              debug.enabled && debug.emit({ type: 'claim', binding, occupant: claim });
            }
            claim.staged = claim.next;
            if (commitOf(claim.spec)) applied.commits.push({ claim, next: claim.next, isNew });
          }
        }
      }

      deliver(target, anchor);
    });
  }

  if (node.children) for (const child of node.children) applyNode(child, liveNodes, applied);

  // Post-order: body-owning claim's commit() runs after all its own edits and child commits
  if (incomingOcc?.kind === 'instance' && commitOf(incomingOcc.spec))
    applied.commits.push({ claim: incomingOcc, next: incomingOcc.next, isNew: incomingIsNew });
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
