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

function isIterable(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function';
}

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

/** @implements {Builder<object, object>} */
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

  createText(text) {
    return { text, parent: null };
  }

  createMarker() {
    return { marker: true, parent: null };
  }

  clone(node) {
    return structuredClone(node);
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

  insert(parent, content, before = null) {
    const nodes = content.fragment ? content.children.slice() : [content];
    for (const node of nodes) detach(node);
    const index = before ? parent.children.indexOf(before) : parent.children.length;
    parent.children.splice(index, 0, ...nodes);
    for (const node of nodes) node.parent = parent;
  }

  extract(start, end) {
    const parent = start.parent,
      from = parent.children.indexOf(start),
      to = parent.children.indexOf(end),
      fragment = { fragment: true, children: parent.children.splice(from, to - from + 1) };
    for (const node of fragment.children) node.parent = fragment;
    return fragment;
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
    if (value?.fragment) return value.children.slice();
    if (value?.start && value?.end) return this.collectRange(value.start, value.end);
    if (Array.isArray(value)) return value.flatMap(this.toNodes, this);
    if (isIterable(value)) return Array.from(value).flatMap(this.toNodes, this);
    if (typeof value === 'object') return [value];
    return [this.createText(String(value))];
  }

  toNode(...values) {
    const nodes = values.flatMap(this.toNodes, this);
    if (nodes.length === 1) return nodes[0];
    return { fragment: true, children: nodes };
  }

  setChild(marker, after, value) {
    const parent = marker.parent;
    if (!parent) return after;

    const isPrimitive = value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
      first = after === marker ? null : this.next(marker);

    if (isPrimitive) {
      const text = value == null || value === false ? '' : String(value);

      if (text && first === after && 'text' in first) {
        first.text = text;
        return after;
      }

      if (!text) {
        if (first) this.remove(first, after);
        return marker;
      }

      const node = this.createText(text);
      this.insert(parent, node, first ?? this.next(marker));
      if (first) this.remove(first, after);
      return node;
    }

    const previous = first ? this.collectRange(first, after) : [],
      next = this.toNodes(value);

    let before = marker.parent.children[marker.parent.children.indexOf(marker) + 1] ?? null,
      tail = marker;
    for (const node of next) {
      if (node === before) before = this.next(before);
      else this.insert(parent, node, before);
      tail = node;
    }
    for (const node of previous)
      if (!next.includes(node)) detach(node);

    return tail;
  }

  // props store raw values; what an attribute means is decided at serialize.
  // storing false and deleting the key both serialize to absence — the same
  // pair the dom builder spells as removeAttribute
  setProp(node, name, value) {
    node.props[name] = value;
  }

  unsetProp(node, name) {
    delete node.props[name];
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
function serializeNode(node, voidElements) {
  if (node == null || node.marker) return '';
  if ('text' in node) return escapeText(String(node.text));

  const children = (node.children ?? [])
    .map((child) => serializeNode(child, voidElements))
    .join('');
  if (node.fragment || !node.type || node.type[0] === '#') return children;

  const open = `<${node.type}${serializeProps(node.props ?? {})}>`;
  if (voidElements.has(node.type.toLowerCase())) return open;
  return `${open}${children}</${node.type}>`;
}

export function serialize(node) {
  return markup.serialize(node);
}
