/* ꙋ temtie · builder · markup.js — the markup medium: an object tree, serialized on demand */
/** @import { Builder } from '../types.d.ts' */

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

function markTree(node) {
  if (!node || typeof node !== 'object') return;
  node[NODE] = true;
  for (const child of node.children ?? []) markTree(child);
}

function el(type) {
  return { type, children: [], props: {}, parent: null, [NODE]: true };
}

function detach(node) {
  const siblings = node.parent?.children;
  if (siblings) siblings.splice(siblings.indexOf(node), 1);
  node.parent = null;
}

function isIterable(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function';
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

/** @implements {Builder<object, object[], object>} */
export class MarkupBuilder {
  static voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  compile(strings) {
    return compileTemplate(strings, this);
  }

  createRoot() {
    return el('#root');
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

  isContainer(node) {
    return Array.isArray(node?.children);
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

  contains(container, node) {
    for (let parent = node; parent; parent = parent.parent)
      if (parent === container) return true;
    return false;
  }

  prev(node) {
    const siblings = node.parent?.children;
    return siblings ? siblings[siblings.indexOf(node) - 1] ?? null : null;
  }

  next(node) {
    const siblings = node.parent?.children;
    return siblings ? siblings[siblings.indexOf(node) + 1] ?? null : null;
  }

  insert(parent, content, after = null) {
    const nodes = [];
    for (const node of Array.isArray(content) ? content : [content]) {
      if (node === after) continue;
      const i = nodes.indexOf(node);
      if (i >= 0) nodes.splice(i, 1);
      nodes.push(node);
    }
    if (!nodes.length) return;

    for (const node of nodes) detach(node);
    const index = after ? parent.children.indexOf(after) + 1 : parent.children.length;
    parent.children.splice(index, 0, ...nodes);
    for (const node of nodes) node.parent = parent;
  }

  extract(start, end) {
    if (!start.parent) throw new Error('temtie/builder/markup: extract: start is detached');
    const nodes = this.collectRange(start, end),
      siblings = start.parent.children;
    siblings.splice(siblings.indexOf(start), nodes.length);
    for (const node of nodes) node.parent = null;
    return start === end ? nodes[0] : nodes;
  }

  remove(start, end) {
    for (const node of this.collectRange(start, end)) detach(node);
  }

  collectRange(start, end) {
    if (start === end) return [start];
    if (!start?.parent || start.parent !== end?.parent)
      throw new Error('temtie/builder/markup: range boundaries must be siblings');

    const siblings = start.parent.children,
      from = siblings.indexOf(start),
      to = siblings.indexOf(end);
    if (from < 0 || to < from)
      throw new Error('temtie/builder/markup: range end is unreachable from start');
    return siblings.slice(from, to + 1);
  }

  toNodes(value) {
    if (value == null || value === false) return [];
    if (Array.isArray(value)) return value.flatMap(this.toNodes, this);
    if (isIterable(value)) return Array.from(value).flatMap(this.toNodes, this);
    if (value && value[NODE]) return [value];
    return [this.createText(String(value))];
  }

  toNode(...values) {
    const nodes = values.flatMap(this.toNodes, this);
    if (nodes.length === 1) return nodes[0];
    return nodes;
  }

  setChild(marker, after, value) {
    const parent = marker.parent;
    if (!parent) return after;

    const next = this.toNodes(value),
      first = after === marker ? null : this.next(marker);

    if (first) this.remove(first, after);

    const before = this.next(marker);
    let tail = marker;
    for (const node of next) {
      this.insert(parent, node, before ? this.prev(before) : null);
      tail = node;
    }
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
  if (node.fragment || !node.type || node.type[0] === '#') return children;

  const open = `<${node.type}${serializeProps(node.props ?? {}, node.sources)}>`;
  if (voidElements.has(node.type.toLowerCase())) return open;
  return `${open}${children}</${node.type}>`;
}

export function serialize(node) {
  return markup.serialize(node);
}
