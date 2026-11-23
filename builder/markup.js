/* ꙋ temtie · builder · markup.js — the markup medium: an object tree, serialized on demand */
/// <reference path="../types.d.ts" />
/** @import { Builder, TemplateBuilder } from 'temtie' */

import { compileTemplate } from '../parser.js';

const NODE = Symbol('markup.node');

function markTree(root) {
  if (!root || typeof root !== 'object') return;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    node[NODE] = true;
    if (node.children)
      for (const child of node.children)
        if (child && typeof child === 'object') stack.push(child);
  }
}

function el(type) {
  return { type, children: [], props: {}, parent: null, [NODE]: true };
}

function spliceRange(start, end) {
  if (!start?.parent || start.parent !== end?.parent)
    throw new Error('temtie/builder/markup: range boundaries must be siblings');
  const siblings = start.parent.children,
    from = siblings.indexOf(start),
    to = siblings.indexOf(end);
  if (from < 0 || to < from)
    throw new Error('temtie/builder/markup: range end is unreachable from start');
  return siblings.splice(from, to - from + 1);
}

const writable = (obj, key) => !!Object.getOwnPropertyDescriptor(obj, key)?.writable;

function canWriteChildren(owner) {
  return Array.isArray(owner?.children)
    && Object.isExtensible(owner.children)
    && writable(owner.children, 'length');
}

function canTouch(array, from, to, flag) {
  for (let i = from; i < to; i++) {
    const desc = Object.getOwnPropertyDescriptor(array, i);
    if (desc && !desc[flag]) return false;
  }
  return true;
}

function insertNodes(parent, items, after) {
  if (!canWriteChildren(parent))
    throw new TypeError('temtie/builder/markup: insert requires a container');
  const afterIndex = after == null ? -1 : parent.children.indexOf(after);
  if (after != null && (after.parent !== parent || afterIndex < 0))
    throw new Error('temtie/builder/markup: insert anchor must belong to its container');

  const moving = new Set();
  for (const node of items) {
    if (node === after) continue;
    if (!writable(node, 'parent'))
      throw new TypeError('temtie/builder/markup: insert requires a writable parent link');
    moving.delete(node);
    moving.add(node);
  }
  if (!moving.size) return [];
  for (let node = parent; node; node = node.parent)
    if (moving.has(node))
      throw new Error('temtie/builder/markup: a node cannot be inserted into its descendant');

  const sources = new Map();
  for (const node of moving)
    if (node.parent) sources.set(node.parent, null);

  let postAfterIndex = afterIndex;
  for (const source of sources.keys()) {
    if (!canWriteChildren(source))
      throw new TypeError('temtie/builder/markup: insert requires writable children');
    const kids = source.children;
    let firstMoved = kids.length, kept = 0;
    for (let i = 0; i < kids.length; i++) {
      if (moving.has(kids[i])) {
        if (firstMoved === kids.length) firstMoved = i;
      } else {
        if (source === parent && i === afterIndex) postAfterIndex = kept;
        kept++;
      }
    }
    if (!canTouch(kids, firstMoved, kept, 'writable') || !canTouch(kids, kept, kids.length, 'configurable'))
      throw new TypeError('temtie/builder/markup: insert requires writable children');
    sources.set(source, { firstMoved, kept });
  }

  const count = moving.size,
    dest = parent.children,
    baseLen = sources.has(parent) ? sources.get(parent).kept : dest.length,
    insertIndex = after == null ? baseLen : postAfterIndex + 1;
  if (baseLen + count > 0xffffffff)
    throw new RangeError('temtie/builder/markup: container length limit exceeded');
  if (!canTouch(dest, insertIndex, baseLen, 'writable'))
    throw new TypeError('temtie/builder/markup: insert requires writable children');

  for (const [source, { firstMoved }] of sources) {
    const kids = source.children;
    let write = firstMoved;
    for (let read = firstMoved; read < kids.length; read++)
      if (!moving.has(kids[read])) kids[write++] = kids[read];
    kids.length = write;
  }

  const nodes = [...moving];
  dest.length = baseLen + count;
  for (let i = baseLen - 1; i >= insertIndex; i--) dest[i + count] = dest[i];
  for (let i = 0; i < count; i++) dest[insertIndex + i] = nodes[i];
  for (const node of nodes) node.parent = parent;
  return nodes;
}

const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  bull: '•', middot: '·', times: '×', divide: '÷', deg: '°', plusmn: '±',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥',
}));

const ENTITY = /&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

const namesUnknown = (source) =>
  source.includes('&') && source.match(ENTITY)?.some((entity) => entity[1] !== '#' && !NAMED_ENTITIES.has(entity.slice(1, -1)));

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (entity, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? entity;
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/**
 * @implements {Builder<object, object>}
 * @implements {TemplateBuilder<object, object>}
 */
export class MarkupBuilder {
  static voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  compile(strings) {
    return compileTemplate(strings, this);
  }

  createRoot() {
    return el('#fragment');
  }

  decodeStatic(value) {
    return decodeEntities(value);
  }

  isVoidElement(tag) {
    return this.constructor.voidElements.has(tag.toLowerCase());
  }

  createElement(tag) {
    return el(tag);
  }

  createText(text, source) {
    const node = { text, parent: null, [NODE]: true };
    if (source !== undefined && namesUnknown(source)) node.source = source;
    return node;
  }

  createMarker() {
    return { marker: true, parent: null, [NODE]: true };
  }

  clone(node) {
    const copy = structuredClone(node);
    markTree(copy);
    return copy;
  }

  resolve(root, path) {
    let node = root;
    for (const index of path) node = node.children[index];
    return node;
  }

  firstChild(node) {
    return node.children[0] ?? null;
  }

  lastChild(node) {
    return node.children.at(-1) ?? null;
  }

  parent(node) {
    return node.parent ?? null;
  }

  prev(node) {
    const siblings = node.parent?.children;
    return siblings ? siblings[siblings.indexOf(node) - 1] ?? null : null;
  }

  insert(parent, content, after = null) {
    if (parent === content)
      throw new Error('temtie/builder/markup: a node cannot be inserted into itself');
    insertNodes(parent, content?.type === '#fragment' ? content.children : [content], after);
  }

  extract(start, end) {
    const fragment = el('#fragment');
    fragment.children = spliceRange(start, end);
    for (const node of fragment.children) node.parent = fragment;
    return fragment;
  }

  remove(start, end) {
    for (const node of spliceRange(start, end)) node.parent = null;
  }

  // strict text write into the hole's permanent text anchor
  setChild(anchor, value) {
    anchor.text = value == null || value === false ? '' : String(value);
    if ('source' in anchor) delete anchor.source;
  }

  setProp(node, name, value, source) {
    node.props[name] = value;
    if (source !== undefined && namesUnknown(source)) (node.sources ??= {})[name] = source;
    else if (node.sources) delete node.sources[name];
  }

  unsetProp(node, name) {
    delete node.props[name];
    if (node.sources) delete node.sources[name];
  }

  serialize(node) {
    return serializeNode(node, this.constructor.voidElements);
  }
}

export const markup = new MarkupBuilder();

const escapeText = (text) =>
  text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));

const escapeAttr = (text) =>
  text.replace(/[&"]/g, (ch) => (ch === '&' ? '&amp;' : '&quot;'));

const INVALID_NAME = /[\s"'>/=]/;

function serializeProps(props, sources) {
  let out = '';
  for (const name of Object.keys(props)) {
    if (INVALID_NAME.test(name)) continue;
    const value = props[name];
    if (value === false || value == null) continue;
    if (typeof value === 'function' || typeof value === 'symbol') continue;
    const source = sources?.[name];
    out += value === true ? ` ${name}`
      : source !== undefined ? ` ${name}="${source.replace(/"/g, '&quot;')}"`
      : ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

function serializeNode(root, voidElements) {
  const out = [], stack = [root];
  while (stack.length) {
    const item = stack.pop();
    if (item == null || item.marker) continue;
    if (typeof item === 'string') { out.push(item); continue; }
    if ('text' in item) { out.push(item.source ?? escapeText(String(item.text))); continue; }
    const isTag = item.type && item.type[0] !== '#';
    if (isTag) {
      out.push(`<${item.type}${serializeProps(item.props ?? {}, item.sources)}>`);
      if (voidElements.has(item.type.toLowerCase())) continue;
      stack.push(`</${item.type}>`);
    }
    const children = item.children;
    if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out.join('');
}

export function serialize(node) {
  return markup.serialize(node);
}
