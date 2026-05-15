/** temtie view — rendering surface over nodes. */
/** @import { Builders, DefaultBuilders, Define, View, RootWithBuilders } from './types.d.ts' */

import { compileTemplate, TEMPLATE_HOLE_TYPES } from './parser.js';
import debug from './debug.js';

const RANGE_LOCATION = {
  INSIDE: 'direct-child',
  NESTED: 'descendant-escape',
  DETACHED: 'detached',
  FOREIGN: 'foreign-parent',
};

const SKIP = Symbol.for('temtie.slotSkip');
const VALUE = Symbol.for('temtie.value');
const PRIVATE = Symbol('temtie.private');

let nextViewId = 0;

export const define = /** @type {Define} */ (Object.assign(
  function stateless(callback) {
    return createSlotCaller(callback, {
      update(render, root) { return render(root); },
    });
  },
  {
    state: function stateful(callback) {
      return createSlotCaller(callback, {
        create(init, root) {
          const render = init(root);
          if (typeof render !== 'function') throw new TypeError('temtie/view: define.state() init must return a render function');
          return render;
        },
        update(init, root, render) {
          return render(...init[VALUE].args);
        },
        dispose (init) {
          if (typeof init === 'function' && typeof init.dispose === 'function') init.dispose();
        }
      });
    } 
  }
));

/**
 * @template {Builders} [Bs=DefaultBuilders]
 * @param {(root: RootWithBuilders<Bs>) => void} renderFn
 * @returns {View<Bs>}
 */
export function view(renderFn) {
  if (typeof renderFn !== 'function') throw new TypeError('temtie/view: view() requires a render function');
  return new TemTieView(renderFn);
}

function createSlotCaller(callback, definition) {
  if (typeof callback !== 'function') throw new TypeError('temtie/view: define() requires a render function');
  return function callSlot(...args) {
    function slot(root) {
      return callback(root, ...args);
    }
    slot[VALUE] = Object.assign({
      type: definition,
      args,
    }, definition);
    return slot;
  };
}

class TemTieView {
  [PRIVATE] = {
    id: null,
    root: null,
    renderFn: null,
    builders: null,
    rootHandlers: null,
    slotHandlers: null,
    roots: null,
    channels: null,
    turn: null,
    schedule: null,
  }

  constructor(renderFn) {
    this[PRIVATE].renderFn = renderFn;
  }

  render = function() {
    throw new Error('temtie/view: cannot render before mount()');
  }

  update = function() {
    throw new Error('temtie/view: cannot update before mount()');
  }

  mount(container, source = {}) {
    const pub = this, priv = this[PRIVATE];
    priv.id = source.id ?? nextViewId++;
    priv.builders = source.builders;
    priv.roots = new WeakMap();
    priv.channels = new WeakMap();
    priv.turn = null;
    priv.schedule = source.scheduleUpdate ?? createMicrotaskSchedule();
    priv.rootHandlers = createTemplateHandlers({ next: renderNextTurn }, priv, createTemplateHandler);
    priv.slotHandlers = createTemplateHandlers({}, priv, createSlotChannelHandler);
    priv.root = rootHandle(priv, container);
    pub.render = priv.root.next.bind(priv.root, priv.renderFn.bind(pub, priv.root));
    pub.update = priv.schedule.bind(pub, pub.render);
    pub.render();
    return pub;
  }
}

function createMicrotaskSchedule() {
  let scheduled;
  return function schedule(callback) {
    if (scheduled === callback) return;
    if (!scheduled) {
      queueMicrotask(runScheduled);
    }
    scheduled = callback;
  };

  function runScheduled() {
    try {
      scheduled();
    } finally {
      scheduled = null;
    }
  }
}

function createTemplateHandlers(bag, viewRecord, createTemplateMethod) {
  for (const channel of Object.keys(viewRecord.builders)) {
    bag[channel] = createTemplateMethod(channel, viewRecord.builders[channel]);
  }

  return bag;
}

function rootHandle(viewRecord, node) {
  if (!node) throw new Error('temtie/view: unable to find parent container');

  let rootHandle = viewRecord.roots.get(node);
  if (rootHandle) return rootHandle;

  rootHandle = Object.assign({
    node,
    [PRIVATE]: viewRecord,
  }, viewRecord.rootHandlers);

  viewRecord.roots.set(node, rootHandle);
  return rootHandle;
}

function renderNextTurn(callback) {
  const viewRecord = this[PRIVATE], previous = viewRecord.turn, turn = { channels: [] };

  viewRecord.turn = turn;
  debug.enabled && debug.emit({ type: 'turn-start', viewId: viewRecord.id });
  try {
    callback();
  } finally {
    flushTurn(turn);
    viewRecord.turn = previous;
  }
}

function flushTurn(turn) {
  for (const channel of turn.channels) {
    flushTarget(channel.target, channel.target.round);
    channel.turn = null;
  }
}

function createTemplateHandler(channel, builder) {
  return function template(strings, ...values) {
    const root = this, viewRecord = root[PRIVATE], 
      renderChannelRecord = getRenderChannel(viewRecord, root.node, channel, builder);

    if (viewRecord.turn) {
      if (renderChannelRecord.turn !== viewRecord.turn) {
        renderChannelRecord.turn = viewRecord.turn;
        beginTarget(renderChannelRecord.target, ++renderChannelRecord.round);
        viewRecord.turn.channels.push(renderChannelRecord);
      }

      const child = renderToTarget(renderChannelRecord.target, strings, values);
      return rootHandle(viewRecord, containerNode(child) ?? root.node);
    }

    debug.enabled && debug.emit({ type: 'turn-start', viewId: viewRecord.id });
    beginTarget(renderChannelRecord.target, ++renderChannelRecord.round);
    const child = renderToTarget(renderChannelRecord.target, strings, values);
    flushTarget(renderChannelRecord.target, renderChannelRecord.target.round);
    return rootHandle(viewRecord, containerNode(child) ?? root.node);
  };
}

function getRenderChannel(viewRecord, container, channel, builder) {
  let byChannel = viewRecord.channels.get(container);
  if (!byChannel) {
    byChannel = new Map();
    viewRecord.channels.set(container, byChannel);
  }

  let renderChannelRecord = byChannel.get(channel);
  if (!renderChannelRecord) {
    renderChannelRecord = {
      builder,
      round: 0,
      turn: null,
      target: createTarget(viewRecord, container, builder),
    };
    byChannel.set(channel, renderChannelRecord);
    return renderChannelRecord;
  }

  if (renderChannelRecord.builder !== builder) throw new Error(`temtie/view: view "${channel}" already uses a different builder`);

  return renderChannelRecord;
}

function getRangeBuilder(range, context) {
  if (!range || (typeof range !== 'object' && typeof range !== 'function'))
    throw new TypeError(`temtie/view: ${context} requires a range object`);

  const builder = range.builder;
  debug.enabled && debug.assert(builder && typeof builder === 'object', `${context} requires a builder`, {
    assert: 'builder',
    range,
    context
  });

  return builder;
}

const { propertyIsEnumerable } = Object.prototype;
function enumerableOwnKeys(object) {
  const result = [];
  for (const key of Reflect.ownKeys(object)) {
    if (!propertyIsEnumerable.call(object, key)) continue;
    result.push(key);
  }
  return result;
}

function assertRange(builder, start, end) {
  debug.assert(typeof builder?.parent === 'function', 'assertRange requires parent()', { assert: 'builder.parent' });
  debug.assert(typeof builder?.next === 'function', 'assertRange requires next()', { assert: 'builder.next' });

  if (!start || !end) throw new Error('temtie/view: invalid range handle: missing start or end boundary');
  if (start === end) return;

  const startParent = builder.parent(start), endParent = builder.parent(end);
  if (startParent !== endParent) {
    throw new Error('temtie/view: invalid range handle: boundary nodes are not siblings');
  }

  let node = start;
  while (node) {
    if (node === end) return;
    node = builder.next(node);
  }

  throw new Error('temtie/view: invalid range handle: end boundary is unreachable from start');
}

function containsTargetNode(target, node) {
  const container = getTargetContainer(target);
  return target.builder.contains(container, node);
}

function getTargetContainer(target) {
  return target.startMarker
    ? target.builder.parent(target.startMarker)
    : target.container;
}

function destroyEntry(entry) {
  if (!entry) return;
  if (entry.range) destroyRange(entry.range);
  entry.rangeHandle = null;
  entry.range = null;
}

function destroyTarget(target) {
  for (const entry of target.order) destroyEntry(entry);
  for (const entry of target.next) destroyEntry(entry);
  target.order = [];
  target.next = [];
  target.round = 0;
  target.cursor = null;
}

function createTarget(viewRecord, container, builder, options = {}) {
  if (debug.enabled) {
    debug.assert(builder && typeof builder === 'object', 'createTarget requires a builder', { assert: 'builder', container });
    debug.assert(typeof builder?.isContainer === 'function', 'createTarget requires isContainer()', { assert: 'builder.isContainer', container });
  }

  if (!builder.isContainer(container)) throw new TypeError('temtie/view: createTarget requires a renderable container');

  return {
    viewRecord,
    container,
    builder,
    startMarker: options.startMarker ?? null,
    endMarker: options.endMarker ?? null,
    round: 0,
    cursor: null,
    order: [],
    next: [],
    buckets: new WeakMap(),
  };
}

function beginTarget(target, round) {
  target.round = round;
  target.cursor = null;

  for (const entry of target.order) {
    const rangeHandle = entry?.rangeHandle;
    if (!rangeHandle?.start || !rangeHandle?.end) continue;
    if (target.builder.parent(rangeHandle.start) === target.container) {
      target.cursor = rangeHandle.start;
      break;
    }
  }

  debug.enabled && debug.emit({
    type: 'setup-target',
    target,
    viewId: target.viewRecord?.id,
    container: target.container,
    builder: target.builder,
    round,
    cursor: target.cursor,
  });

  return target;
}

function renderToTarget(target, stringsOrTemplate, values = []) {
  debug.enabled && debug.assert(target, 'renderToTarget requires a valid target', { assert: 'target', stringsOrTemplate });

  const template = resolveTemplate(target, stringsOrTemplate),
    bucket = getTargetBucket(target, template),
    key = (Number.isInteger(template.keySlot) && template.keySlot >= 0)
      ? values[template.keySlot]
      : undefined,
    entry = getTargetEntry(bucket, key, target.round),
    wasReused = !!entry.rangeHandle;

  entry.round = target.round;
  if (!target.next.includes(entry)) target.next.push(entry);

  debug.enabled && debug.emit({
    type: 'render-to',
    target,
    viewId: target.viewRecord?.id,
    template,
    site: template.site ?? template,
    key,
    round: target.round,
  });

  if (entry.rangeHandle) updateEntry(target, template, entry, values);
  else createEntry(target, template, entry, values, wasReused);

  return entry.rangeHandle;
}

function resolveTemplate(target, stringsOrTemplate) {
  if (stringsOrTemplate?.raw) return compileTemplate(stringsOrTemplate, target.builder, { vctx: target.viewRecord });

  if (!stringsOrTemplate || (typeof stringsOrTemplate !== 'object' && typeof stringsOrTemplate !== 'function'))
    throw new TypeError('temtie/view: renderToTarget requires template strings or a compiled template');

  if (stringsOrTemplate.builder !== target.builder)
    throw new Error('temtie/view: compiled template builder must match target.builder');

  return stringsOrTemplate;
}

function updateEntry(target, template, entry, values) {
  placeInTarget(target, entry.rangeHandle);

  try {
    const result = entry.rangeHandle.apply(values);
    if (result === null) {
      const next = entry.rangeHandle?.end ? target.builder.next(entry.rangeHandle.end) : null;
      debug.enabled && debug.emit({
        type: 'element-reattached',
        target,
        viewId: target.viewRecord?.id,
        template,
        entry,
        rangeHandle: entry.rangeHandle,
        cause: 'identity-change',
        details: { replacement: true },
      });
      if (target.cursor === entry.rangeHandle?.start) target.cursor = next;
      destroyEntry(entry);
    }
    if (entry.rangeHandle)
      debug.enabled && debug.emit({
        type: 'element-reused',
        target,
        viewId: target.viewRecord?.id,
        template,
        entry,
        rangeHandle: entry.rangeHandle,
      });
  } catch (error) {
    debug.enabled && debug.emit({
      type: 'binding-error',
      target,
      viewId: target.viewRecord?.id,
      template,
      entry,
      error,
    });
    const next = entry.rangeHandle?.end ? target.builder.next(entry.rangeHandle.end) : null;
    if (target.cursor === entry.rangeHandle?.start) {
      target.cursor = next;
    }
    destroyEntry(entry);
    throw error;
  }
}

function createEntry(target, template, entry, values, wasReused) {
  const created = createTargetRange(target, template);
  entry.range = created.range;
  entry.rangeHandle = created.rangeHandle;

  placeInTarget(target, entry.rangeHandle);

  try {
    const result = entry.rangeHandle.apply(values);
    if (result === null) {
      destroyEntry(entry);
      throw new Error('temtie/view: fresh template range rejected initial binding');
    }
    debug.enabled && debug.emit({
      type: 'element-created',
      target,
      viewId: target.viewRecord?.id,
      template,
      entry,
      rangeHandle: entry.rangeHandle,
      reason: wasReused ? 'recovery' : 'initial',
    });
  } catch (error) {
    debug.enabled && debug.emit({
      type: 'binding-error',
      target,
      viewId: target.viewRecord?.id,
      template,
      entry,
      error,
    });
    destroyEntry(entry);
    throw error;
  }
}

function getTargetBucket(target, template) {
  debug.enabled && debug.assert(target, 'getTargetBucket requires a valid target', { assert: 'target', template });

  let bucket = target.buckets.get(template);
  if (!bucket) {
    bucket = { byIndex: [], byKey: new Map(), used: 0, round: 0 };
    target.buckets.set(template, bucket);
  }

  if (bucket.round !== target.round) {
    bucket.round = target.round;
    bucket.used = 0;
  }

  return bucket;
}

function getTargetEntry(bucket, key, round) {
  if (key != null) {
    let entry = bucket.byKey.get(key);
    if (!entry) {
      entry = { round: 0, rangeHandle: null, range: null };
      bucket.byKey.set(key, entry);
    }

    debug.enabled && debug.assert(entry.round !== round, 'temtie/view: duplicate key in same container/template bucket', { 
      assert: 'duplicate-key', 
      key, 
      round,
      entry
    });

    return entry;
  }

  const index = bucket.used++;
  if (!bucket.byIndex[index]) bucket.byIndex[index] = { round: 0, rangeHandle: null, range: null };

  return bucket.byIndex[index];
}

function getRangeLocation(target, rangeHandle) {
  debug.enabled && debug.assert(target, 'getRangeLocation requires a valid target', { assert: 'target', rangeHandle });

  if (!rangeHandle?.start) return RANGE_LOCATION.DETACHED;
  const parent = target.builder.parent(rangeHandle.start), container = getTargetContainer(target);
  if (parent === container) return RANGE_LOCATION.INSIDE;
  if (!parent) return RANGE_LOCATION.DETACHED;
  if (containsTargetNode(target, rangeHandle.start)) return RANGE_LOCATION.NESTED;

  return RANGE_LOCATION.FOREIGN;
}

function placeInTarget(target, rangeHandle) {
  debug.enabled && debug.assert(target, 'placeInTarget requires a valid target', { assert: 'target', rangeHandle });

  if (!rangeHandle?.start || !rangeHandle?.end) throw new TypeError('temtie/view: placeInTarget requires a rangeHandle with start and end boundaries');

  const builder = target.builder,
    location = getRangeLocation(target, rangeHandle),
    container = getTargetContainer(target),
    before = target.cursor ?? target.endMarker ?? null;

  if (location === RANGE_LOCATION.INSIDE && rangeHandle.start === before) {
    target.cursor = builder.next(rangeHandle.end);
    return;
  }

  if (location === RANGE_LOCATION.NESTED) {
    debug.enabled && debug.emit({
      type: 'element-reattached',
      target,
      viewId: target.viewRecord?.id,
      entry: null,
      rangeHandle,
      fromLocation: RANGE_LOCATION.INSIDE,
      toLocation: RANGE_LOCATION.NESTED,
      cause: 'placement',
    });
    return;
  }

  debug.enabled && assertRange(builder, rangeHandle.start, rangeHandle.end);

  const content = builder.extract(rangeHandle.start, rangeHandle.end);
  builder.insert(container, content, before);
  target.cursor = builder.next(rangeHandle.end);
}

function flushTarget(target, round) {
  debug.enabled && debug.assert(target, 'flushTarget requires a valid target', { assert: 'target', round });

  for (const entry of target.order) {
    if (!entry || entry.round === round) continue;

    const rangeHandle = entry.rangeHandle;
    if (!rangeHandle?.start || !rangeHandle?.end) {
      entry.rangeHandle = null;
      entry.range = null;
      continue;
    }

    const location = getRangeLocation(target, rangeHandle);
    if (location === RANGE_LOCATION.INSIDE) {
      debug.enabled && debug.emit({
        type: 'dispose-entry',
        target,
        viewId: target.viewRecord?.id,
        entry,
        rangeHandle,
        round,
      });
      destroyEntry(entry);
      continue;
    }

    if (location === RANGE_LOCATION.NESTED)
      debug.enabled && debug.emit({
        type: 'element-reattached',
        target,
        viewId: target.viewRecord?.id,
        entry,
        rangeHandle,
        fromLocation: RANGE_LOCATION.INSIDE,
        toLocation: RANGE_LOCATION.NESTED,
        cause: 'flush-observation',
        details: { round },
      });

    entry.rangeHandle = null;
    entry.range = null;
  }

  target.order = target.next;
  target.next = [];
  target.round = 0;
  target.cursor = null;

  debug.enabled && debug.emit({
    type: 'commit-target',
    target,
    viewId: target.viewRecord?.id,
    container: getTargetContainer(target),
    builder: target.builder,
    round,
    orderLength: target.order.length,
  });

  return target;
}

function createTargetRange(target, template) {
  debug.enabled && debug.assert(target, 'createTargetRange requires a valid target', { assert: 'target', template });

  if (template.builder !== target.builder) throw new Error('temtie/view: compiled template builder must match target.builder');

  const range = createRange(target, template), rangeHandle = createRangeHandle(range);
  return { range, rangeHandle };
}

function createRange(target, template) {
  const { builder } = template;

  if (debug.enabled) {
    debug.assert(typeof builder?.clone === 'function', 'createRange requires clone()', { assert: 'builder.clone', template });
    debug.assert(typeof builder?.firstChild === 'function', 'createRange requires firstChild()', { assert: 'builder.firstChild', template });
    debug.assert(typeof builder?.lastChild === 'function', 'createRange requires lastChild()', { assert: 'builder.lastChild', template });
    debug.assert(typeof builder?.createMarker === 'function', 'createRange requires createMarker()', { assert: 'builder.createMarker', template });
    debug.assert(typeof builder?.insert === 'function', 'createRange requires insert()', { assert: 'builder.insert', template });
    debug.assert(typeof builder?.isContainer === 'function', 'createRange requires isContainer()', { assert: 'builder.isContainer', template });
  }

  const fragment = builder.clone(template.fragment);
  let start = builder.firstChild(fragment), end = builder.lastChild(fragment);

  if (!start) {
    const marker = builder.createMarker();
    builder.insert(fragment, marker);
    start = marker;
    end = marker;
  }

  const range = {
    target,
    builder,
    template,
    fragment,
    start,
    end,
    node: start === end && builder.isContainer(start) ? start : null,
    bindings: null,
  };
  range.bindings = createBindings(range);
  debug.enabled && assertRange(builder, start, end);
  return range;
}

function createRangeHandle(range) {
  getRangeBuilder(range, 'createHandle');

  if (!range.start || !range.end)
    throw new TypeError('temtie/view: createRangeHandle requires range.start and range.end');

  return {
    builder: range.builder,
    start: range.start,
    end: range.end,
    node: range.node ?? null,
    range,
    apply: applyBindings,
  };
}

function applyBindings(values) {
  const range = this.range;
  for (let i = 0; i < range.bindings.length; i++)
    if (applyBinding(range, range.bindings[i], values) === null) return null;
}

function destroyRange(range) {
  const builder = getRangeBuilder(range, 'destroyRange'), { start, end } = range;
  if (!start || !end) return;
  for (const binding of range.bindings) disposeBinding(binding);
  builder.remove(start, end);
}

function createBindings(range) {
  const { template, fragment, builder } = range;

  if (debug.enabled) {
    debug.assert(builder && typeof builder === 'object', 'createBindings requires a builder', { assert: 'builder', template });
    debug.assert(typeof builder?.resolve === 'function', 'createBindings requires resolve()', { assert: 'builder.resolve', template });
    debug.assert(typeof builder?.setChild === 'function', 'createBindings requires setChild()', { assert: 'builder.setChild', template });
    debug.assert(typeof builder?.setProp === 'function', 'createBindings requires setProp()', { assert: 'builder.setProp', template });
    debug.assert(typeof builder?.unsetProp === 'function', 'createBindings requires unsetProp()', { assert: 'builder.unsetProp', template });
  }

  const bindings = [];
  for (const hole of template.holes) {
    if (hole?.type === TEMPLATE_HOLE_TYPES.ATTR && hole.slot === template.keySlot) continue;
    if (hole.type === TEMPLATE_HOLE_TYPES.META) continue;

    if (hole.type === TEMPLATE_HOLE_TYPES.CHILD) {
      bindings.push({
        type: TEMPLATE_HOLE_TYPES.CHILD,
        index: hole.slot,
        start: builder.resolve(fragment, hole.startPath),
        end: builder.resolve(fragment, hole.endPath),
        prev: undefined,
        target: null,
        slotRoot: null,
        slotMemo: null,
      });
      continue;
    }

    const node = builder.resolve(fragment, hole.path);

    if (hole.type === TEMPLATE_HOLE_TYPES.ATTR) {
      bindings.push({
        type: TEMPLATE_HOLE_TYPES.ATTR,
        index: hole.slot,
        node,
        prop: hole.prop,
        prev: undefined,
      });
      continue;
    }

    if (hole.type === TEMPLATE_HOLE_TYPES.SPREAD) {
      bindings.push({
        type: TEMPLATE_HOLE_TYPES.SPREAD,
        index: hole.slot,
        node,
        prev: {},
      });
      continue;
    }
  }

  return bindings;
}

function applyBinding(range, binding, values) {
  if (binding.type === TEMPLATE_HOLE_TYPES.CHILD)
    return applyChildBinding(range, binding, values);

  if (binding.type === TEMPLATE_HOLE_TYPES.ATTR)
    return applyAttrBinding(range, binding, values);

  return applySpreadBinding(range, binding, values);
}

function applyChildBinding(range, binding, values) {
  const next = values[binding.index], protocol = next?.[VALUE];

  if (protocol) return applySlotBinding(range, binding, next, protocol);
  if (next === binding.prev && next != null) return;

  if (binding.prev?.[VALUE] && binding.target) {
    const round = beginSlotRange(binding.target);
    flushSlotRange(binding.target, round);
    disposeSlotBinding(binding);
    binding.slotMemo = null;
  }

  range.builder.setChild(binding.start, binding.end, next);
  binding.prev = next;
}

function applySlotBinding(range, binding, next, protocol) {
  if (typeof protocol.update !== 'function') throw new TypeError('temtie/view: value protocol requires update()');

  if (typeof binding.prev !== 'function' && !binding.prev?.[VALUE])
    range.builder.setChild(binding.start, binding.end, null);

  if (!binding.target) {
    const container = range.builder.parent(binding.start);
    if (!container) return undefined;
    binding.target = {
      viewRecord: range.target.viewRecord,
      container,
      startMarker: binding.start,
      endMarker: binding.end,
      nextRound: 0,
      activeRound: null,
      targets: new Map(),
    }
    binding.slotRoot = createSlotRoot(binding.target);
  }

  const round = beginSlotRange(binding.target);
  ensureSlotMemo(binding, next, protocol);
  const result = protocol.update(next, binding.slotRoot, binding.slotMemo.value);

  if (result === SKIP) {
    binding.target.activeRound = null;
    binding.prev = next;
    return;
  }

  flushSlotRange(binding.target, round);
  binding.prev = next;
}

function ensureSlotMemo(binding, next, protocol) {
  const type = protocol.type ?? protocol;
  if (binding.slotMemo?.type === type) return;

  disposeSlotBinding(binding);
  binding.slotMemo = {
    type,
    protocol,
    value: protocol.create?.(next, binding.slotRoot),
  };
}

function disposeBinding(binding) {
  if (binding?.type !== TEMPLATE_HOLE_TYPES.CHILD) return;

  if (binding.target) {
    const slotRange = binding.target;
    for (const target of slotRange.targets.values()) destroyTarget(target);
    slotRange.targets.clear();
    slotRange.activeRound = null;
  }

  disposeSlotBinding(binding);
  binding.target = null;
  binding.slotRoot = null;
}

function disposeSlotBinding(binding) {
  const slotMemo = binding?.slotMemo;
  if (!slotMemo) return;
  slotMemo.protocol?.dispose?.(slotMemo.value);
  binding.slotMemo = null;
}

function applyAttrBinding(range, binding, values) {
  const next = values[binding.index];
  if (next === binding.prev) return undefined;
  range.builder.setProp(binding.node, binding.prop, next);
  binding.prev = next;
}

function applySpreadBinding(range, binding, values) {
  const value = values[binding.index],
    next = value == null ? {} : Object(value),
    nextKeys = enumerableOwnKeys(next);

  for (const key of enumerableOwnKeys(binding.prev)) 
    if (!nextKeys.includes(key))
      range.builder.unsetProp(binding.node, key);

  for (const key of nextKeys) 
    if (binding.prev[key] !== next[key])
      range.builder.setProp(binding.node, key, next[key]);

  binding.prev = next;
}

function createSlotRoot(slotRange) {
  return Object.assign({
    [PRIVATE]: slotRange,
    node: slotRange.container,
    next: renderNextInSlotRange,
  }, slotRange.viewRecord.slotHandlers);
}

function createSlotChannelHandler(channel, builder) {
  return function slotTemplate(strings, ...values) {
    const slotRange = this[PRIVATE],
      target = prepareSlotTarget(slotRange, channel, builder),
      rangeHandle = renderToTarget(target, strings, values);
    return rootHandle(slotRange.viewRecord, containerNode(rangeHandle) ?? slotRange.container);
  };
}

function renderNextInSlotRange(callback) {
  const slotRange = this[PRIVATE],
    viewRecord = slotRange.viewRecord,
    previous = viewRecord.turn,
    turn = { channels: [] };

  viewRecord.turn = turn;
  const round = beginSlotRange(slotRange);

  try {
    callback();
  } finally {
    flushTurn(turn);
    viewRecord.turn = previous;
    flushSlotRange(slotRange, round);
  }
}

function beginSlotRange(slotRange) {
  const round = ++slotRange.nextRound;
  slotRange.activeRound = { round };
  return round;
}

function prepareSlotTarget(slotRange, channel, builder) {
  let target = slotRange.targets.get(channel);
  if (!target) {
    target = createTarget(slotRange.viewRecord, slotRange.container, builder, {
      startMarker: slotRange.startMarker,
      endMarker: slotRange.endMarker,
    });
    slotRange.targets.set(channel, target);
  }

  const activeRound = slotRange.activeRound ?? { round: ++slotRange.nextRound };
  slotRange.activeRound = activeRound;
  if (target.round !== activeRound.round) beginTarget(target, activeRound.round);
  return target;
}

function flushSlotRange(slotRange, round) {
  for (const target of slotRange.targets.values()) flushTarget(target, round);
  slotRange.activeRound = null;
}

function containerNode(rangeHandle) {
  return rangeHandle?.node && rangeHandle.builder.isContainer(rangeHandle.node) ? rangeHandle.node : null;
}
