/* ꙋ temtie · builder · markup.js — the markup medium: an object tree, serialized on demand */
/// <reference path="../types.d.ts" />
/** @import { Builder, TemplateBuilder } from 'temtie' */

import { compileTemplate } from '../parser.js';

// the medium is a plain object tree — no document, no platform. the tree is
// the committed state; serialize() reads it whenever a string is wanted, so
// one render serializes many times and a flow's settle re-serializes. the
// builder is named for the medium it writes, not the syntax it accepts:
// swap compile() and something other than html parses into the same tree.

// a node the builder made carries this; a value is adopted as a node only if
// it does. a plain object is data, not a node — it is String()'d, never moved
// into the medium, and never mutated (Q44/Q45).
const NODE = Symbol('markup.node');
const OWNED = Symbol('markup.owned');

function markTree(node) {
  if (!node || typeof node !== 'object') return;
  node[NODE] = true;
  for (const child of node.children ?? []) markTree(child);
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

function toNodes(builder, value) {
  if (value == null || value === false) return [];
  if (value[NODE]) return value.type === '#fragment' ? [...value.children] : [value];
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function')
    return Array.from(value, (item) => toNodes(builder, item)).flat();
  return [builder.createText(String(value))];
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

// statics decode into the tree for common names and numeric references. A
// static naming an entity this table lacks keeps its source, which serialize
// writes as written, so the browser decodes the name itself
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
    // like a DOM fragment, the lifted run keeps a parent: a range nested in it
    // can still be lifted out on its own later
    const fragment = el('#fragment');
    fragment.children = spliceRange(start, end);
    for (const node of fragment.children) node.parent = fragment;
    return fragment;
  }

  remove(start, end) {
    for (const node of spliceRange(start, end)) node.parent = null;
  }

  setChild(marker, after, value) {
    const parent = marker.parent;
    if (!parent) return after;

    const next = toNodes(this, value);
    if (after !== marker) {
      const ranges = marker[OWNED],
        owned = ranges?.get(after),
        from = parent.children.indexOf(marker) + 1;
      if (owned) {
        let to = from;
        while (owned.has(parent.children[to])) to++;
        if (to > from) this.remove(parent.children[from], parent.children[to - 1]);
        ranges.delete(after);
        if (!ranges.size) marker[OWNED] = null;
      } else if (parent.children[from] === after) {
        this.remove(after, after);
      }
    }
    const placed = next.length ? insertNodes(parent, next, marker) : [],
      tail = placed.at(-1) ?? marker;
    if (placed.length > 1) (marker[OWNED] ??= new Map()).set(tail, new Set(placed));
    return tail;
  }

  // props store raw values; what an attribute means is decided at serialize.
  // storing false and deleting the key both serialize to absence — the same
  // pair the dom builder spells as removeAttribute
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

// values never reach the markup as markup: a string value became a text node
// at write time, and every text node and attribute value escapes here — the
// parity the dom builder gets from the platform. this holds inside <script>
// and <style> too: interpolating markup-significant text there is refused by
// escaping, not honored
function serializeNode(node, voidElements) {
  if (node == null || node.marker) return '';
  if ('text' in node) return node.source ?? escapeText(String(node.text));

  const children = (node.children ?? [])
    .map((child) => serializeNode(child, voidElements))
    .join('');
  if (!node.type || node.type[0] === '#') return children;

  const open = `<${node.type}${serializeProps(node.props ?? {}, node.sources)}>`;
  if (voidElements.has(node.type.toLowerCase())) return open;
  return `${open}${children}</${node.type}>`;
}

export function serialize(node) {
  return markup.serialize(node);
}
