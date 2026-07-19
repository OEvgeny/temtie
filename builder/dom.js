/* ꙋ temtie · builder · dom.js */
/** @import { Builder } from '../types.d.ts' */

import { compileTemplate } from '../parser.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEMTIE_PROP_NAMES = Symbol.for('temtie.propNames');

function isDomNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

function isIterable(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function';
}

function shouldSetProperty(node, name) {
  return (
    typeof name === 'symbol' ||
    (typeof name === 'string' && name.startsWith('on')) ||
    node?.[TEMTIE_PROP_NAMES]?.has(name)
  );
}

function setText(node, text) {
  if (node.nodeValue !== text) node.nodeValue = text;
}

/** @implements {Builder<Node, DocumentFragment>} */
export class DOMBuilder {
  #decoder = null;

  static voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  constructor(document = globalThis.document) {
    this.document = document;
  }

  compile(strings) {
    return compileTemplate(strings, this);
  }

  createRoot() {
    return this.document.createDocumentFragment();
  }

  decodeStatic(value) {
    if (!value.includes('&')) return value;
    const textarea = this.#decoder ??= this.document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
  }

  createElement(tag) {
    return this.document.createElement(tag);
  }

  createText(text) {
    return this.document.createTextNode(text);
  }

  createMarker() {
    return this.document.createComment('');
  }

  setProp(node, name, value) {
    if (shouldSetProperty(node, name)) {
      node[name] = value ?? null;
      return;
    }

    if (value === true)
      node.setAttribute(name, '');
    else if (value === false || value == null)
      node.removeAttribute(name);
    else
      node.setAttribute(name, String(value));
  }

  unsetProp(node, name) {
    if (shouldSetProperty(node, name)) {
      node[name] = null;
      return;
    }

    node.removeAttribute(name);
  }

  clone(root) {
    return root.cloneNode(true);
  }

  resolve(root, path) {
    let node = root;
    for (const index of path) node = node.childNodes[index];
    return node;
  }

  isContainer(node) {
    return !!node && (
      node.nodeType === 1 ||
      node.nodeType === 11
    );
  }

  firstChild(container) {
    return container.firstChild;
  }

  lastChild(container) {
    return container.lastChild;
  }

  parent(node) {
    return node.parentNode ?? null;
  }

  contains(container, node) {
    return typeof container?.contains === 'function'
      ? container.contains(node)
      : false;
  }

  insert(parent, child, before = null) {
    if (before) {
      parent.insertBefore(child, before);
      return;
    }

    parent.append(child);
  }

  extract(start, end) {
    if (start === end) {
      start.parentNode?.removeChild(start);
      return start;
    }

    const range = (start.ownerDocument ?? this.document).createRange();
    range.setStartBefore(start);
    range.setEndAfter(end);
    return range.extractContents();
  }

  remove(start, end) {
    if (start === end) {
      start.parentNode?.removeChild(start);
      return;
    }

    const range = (start.ownerDocument ?? this.document).createRange();
    range.setStartBefore(start);
    range.setEndAfter(end);
    range.deleteContents();
  }

  next(node) {
    return node.nextSibling ?? null;
  }

  prev(node) {
    return node.previousSibling ?? null;
  }

  isVoidElement(tag) {
    return this.constructor.voidElements.has(tag.toLowerCase());
  }

  collectRange(start, end) {
    if (!isDomNode(start) || !isDomNode(end))
      throw new Error('temtie/builder/dom: range boundaries must be DOM nodes');

    if (start === end) return [start];

    const startParent = start.parentNode ?? null,
      endParent = end.parentNode ?? null;

    if (startParent !== endParent)
      throw new Error('temtie/builder/dom: invalid range handle: boundary nodes are not siblings');

    const nodes = [];
    let node = start;

    while (node) {
      nodes.push(node);
      if (node === end) return nodes;
      node = node.nextSibling;
    }

    throw new Error('temtie/builder/dom: invalid range handle: end boundary is unreachable from start');
  }

  toNodes(value) {
    if (value == null || value === false) return [];
    if (isDomNode(value))
      return value.nodeType === 11 ? Array.from(value.childNodes) : [value];
    if (
      typeof value === 'object' &&
      value &&
      isDomNode(value.start) &&
      isDomNode(value.end)
    ) return this.collectRange(value.start, value.end);
    if (Array.isArray(value))
      return value.flatMap(this.toNodes, this);
    if (isIterable(value))
      return Array.from(value).flatMap(this.toNodes, this);
    return [this.createText(String(value))];
  }

  toNode(...values) {
    const nodes = values.flatMap(this.toNodes, this);
    if (nodes.length === 1) return nodes[0];

    const fragment = this.document.createDocumentFragment();
    fragment.append(...nodes);
    return fragment;
  }

  // The marker is the permanent left anchor; `after` is the range's current
  // tail, with marker itself spelling empty. Replacement may retain and reorder
  // owned nodes, but releases every node left outside the next range.
  setChild(marker, after, value) {
    const parent = marker.parentNode;
    if (!parent) return after;

    const isPrimitive = value == null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
      first = after === marker ? null : marker.nextSibling;

    if (isPrimitive) {
      const text = value == null || value === false ? '' : String(value);

      if (text && first === after && first.nodeType === 3) {
        setText(first, text);
        return after;
      }

      if (!text) {
        if (first) this.remove(first, after);
        return marker;
      }

      const node = this.createText(text);
      parent.insertBefore(node, first ?? marker.nextSibling);
      if (first) this.remove(first, after);
      return node;
    }

    const previous = first ? this.collectRange(first, after) : [],
      next = this.toNodes(value);

    let before = marker.nextSibling,
      tail = marker;
    for (const node of next) {
      if (node === before) before = before.nextSibling;
      else parent.insertBefore(node, before);
      tail = node;
    }
    for (const node of previous)
      if (!next.includes(node)) node.parentNode?.removeChild(node);

    return tail;
  }
}

export class SVGBuilder extends DOMBuilder {
  static voidElements = new Set();

  createElement(tag) {
    return this.document.createElementNS(SVG_NAMESPACE, tag);
  }
}

export const dom = new DOMBuilder();
export const svg = new SVGBuilder();
