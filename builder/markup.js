/* ꙋ temtie · builder · markup.js — the markup medium: an object tree, serialized on demand */
/** @import { Builder } from '../types.d.ts' */

import { compileTemplate } from '../parser.js';

// the medium is a plain object tree — no document, no platform. the tree is
// the committed state; serialize() reads it whenever a string is wanted, so
// one render serializes many times and a flow's settle re-serializes. the
// builder is named for the medium it writes, not the syntax it accepts:
// swap compile() and something other than html parses into the same tree.

function el(type) {
  return { type, children: [], props: {}, parent: null };
}

function detach(node) {
  const siblings = node.parent?.children;
  if (siblings) siblings.splice(siblings.indexOf(node), 1);
  node.parent = null;
}

function collectRange(start, end) {
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

function isIterable(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function';
}

function toNodes(value) {
  if (value == null || value === false) return [];
  if (value?.fragment) return value.children.slice();
  if (value?.start && value?.end) return collectRange(value.start, value.end);
  if (Array.isArray(value)) return value.flatMap(toNodes);
  if (isIterable(value)) return Array.from(value).flatMap(toNodes);
  if (typeof value === 'object') return [value];
  return [{ text: String(value), parent: null }];
}

function toNode(...values) {
  const nodes = values.flatMap(toNodes);
  if (nodes.length === 1) return nodes[0];
  return { fragment: true, children: nodes };
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

// statics arrive spelled as markup: entities decode into the tree once, and
// serialize re-encodes — the same round trip a DOM tree makes for free
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
    const code = body[1] === 'x' || body[1] === 'X'
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** @type {Builder<object, object>} */
export const MarkupBuilder = {
  compile(strings) {
    return compileTemplate(strings, this);
  },

  createRoot: () => el('#root'),
  decodeStatic: (value) => decodeEntities(value),
  isVoidElement: (tag) => VOID_ELEMENTS.has(tag.toLowerCase()),
  createElement: (tag) => el(tag),
  createText: (text) => ({ text, parent: null }),
  createMarker: () => ({ marker: true, parent: null }),

  clone(node) {
    return structuredClone(node);
  },

  resolve(root, path) {
    let node = root;
    for (const index of path) node = node.children[index];
    return node;
  },

  firstChild: (node) => node.children[0] ?? null,
  lastChild: (node) => node.children.at(-1) ?? null,
  parent: (node) => node.parent ?? null,

  prev(node) {
    const siblings = node.parent?.children;
    return siblings ? siblings[siblings.indexOf(node) - 1] ?? null : null;
  },

  next(node) {
    const siblings = node.parent?.children;
    return siblings ? siblings[siblings.indexOf(node) + 1] ?? null : null;
  },

  insert(parent, content, before = null) {
    const nodes = content.fragment ? content.children.slice() : [content];
    for (const node of nodes) detach(node);
    const index = before ? parent.children.indexOf(before) : parent.children.length;
    parent.children.splice(index, 0, ...nodes);
    for (const node of nodes) node.parent = parent;
  },

  extract(start, end) {
    const parent = start.parent,
      from = parent.children.indexOf(start),
      to = parent.children.indexOf(end),
      fragment = { fragment: true, children: parent.children.splice(from, to - from + 1) };
    for (const node of fragment.children) node.parent = fragment;
    return fragment;
  },

  collectRange,
  toNode,
  toNodes,

  setChild(marker, after, value) {
    const parent = marker.parent;
    if (!parent) return after;

    const previous = after === marker ? [] : collectRange(this.next(marker), after),
      isPrimitive = value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
      text = isPrimitive && value != null && value !== false ? String(value) : '';

    if (text && previous.length === 1 && 'text' in previous[0]) {
      previous[0].text = text;
      return after;
    }

    const next = text
      ? [{ text, parent: null }]
      : isPrimitive
        ? []
        : [...new Set(toNodes(value))],
      retained = new Set(next);

    let before = marker.parent.children[marker.parent.children.indexOf(marker) + 1] ?? null;
    for (const node of next) {
      if (node === before) before = this.next(before);
      else this.insert(parent, node, before);
    }
    for (const node of previous)
      if (!retained.has(node)) detach(node);

    return next.at(-1) ?? marker;
  },

  // props store raw values; what an attribute means is decided at serialize.
  // storing false and deleting the key both serialize to absence — the same
  // pair the dom builder spells as removeAttribute
  setProp(node, name, value) {
    node.props[name] = value;
  },

  unsetProp(node, name) {
    delete node.props[name];
  },
};

const escapeText = (text) =>
  text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));

const escapeAttr = (text) =>
  text.replace(/[&"]/g, (ch) => (ch === '&' ? '&amp;' : '&quot;'));

const INVALID_NAME = /[\s"'>/=]/;

function serializeProps(props) {
  let out = '';
  for (const name of Object.keys(props)) {
    // on* mirror the dom builder's property route: never an attribute
    if (name.startsWith('on') || INVALID_NAME.test(name)) continue;
    const value = props[name];
    if (value === false || value == null) continue;
    if (typeof value === 'function' || typeof value === 'symbol') continue;
    out += value === true ? ` ${name}` : ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

// values never reach the markup as markup: a string value became a text node
// at write time, and every text node and attribute value escapes here — the
// parity the dom builder gets from the platform. this holds inside <script>
// and <style> too: interpolating markup-significant text there is refused by
// escaping, not honored
export function serialize(node) {
  if (node == null || node.marker) return '';
  if ('text' in node) return escapeText(String(node.text));

  const children = (node.children ?? []).map(serialize).join('');
  if (node.fragment || !node.type || node.type[0] === '#') return children;

  const open = `<${node.type}${serializeProps(node.props ?? {})}>`;
  if (VOID_ELEMENTS.has(node.type.toLowerCase())) return open;
  return `${open}${children}</${node.type}>`;
}
