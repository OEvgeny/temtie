/* ꙋ temtie · builder · dom.js */
/** @import { Builder } from '../types.d.ts' */

import { compileTemplate } from '../parser.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEMTIE_PROP_NAMES = Symbol.for('temtie.propNames');

function getGlobalDocument() {
  if (globalThis.document) return globalThis.document;

  throw new TypeError('temtie/builder/dom: a global document is required');
}

function getOwnerDocument(node) {
  return node?.ownerDocument ?? getGlobalDocument();
}

function isDomNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

function isIterable(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function';
}

function decodeEntities(text) {
  if (!text.includes('&')) return text;

  const document = getGlobalDocument(),
    textarea = decodeEntities.textarea ??= document.createElement('textarea');

  textarea.innerHTML = text;
  return textarea.value;
}

function shouldSetProperty(node, name) {
  return (
    typeof name === 'symbol' ||
    (typeof name === 'string' && name.startsWith('on')) ||
    node?.[TEMTIE_PROP_NAMES]?.has(name)
  );
}

function collectRange(start, end) {
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

function toNodes(value) {
  if (value == null || value === false) return [];
  if (isDomNode(value))
    return value.nodeType === 11 ? Array.from(value.childNodes) : [value];
  if (
    typeof value === 'object' &&
    value &&
    isDomNode(value.start) &&
    isDomNode(value.end)
  ) return collectRange(value.start, value.end);

  if (Array.isArray(value))
    return value.flatMap((entry) => toNodes(entry));
  if (isIterable(value))
    return Array.from(value).flatMap((entry) => toNodes(entry));

  return [getGlobalDocument().createTextNode(String(value))];
}

function toNode(...values) {
  const nodes = values.flatMap((value) => toNodes(value));
  if (nodes.length === 1) return nodes[0];

  const fragment = getGlobalDocument().createDocumentFragment();
  fragment.append(...nodes);
  return fragment;
}

function setText(node, text) {
  if (node.nodeValue !== text) node.nodeValue = text;
}

function removeRange(start, end) {
  if (start === end) {
    start.parentNode?.removeChild(start);
    return;
  }

  const document = getOwnerDocument(start),
    range = document.createRange();

  range.setStartBefore(start);
  range.setEndAfter(end);
  range.deleteContents();
}

// the marker is the permanent left anchor; `after` is the range's current
// tail, with marker itself spelling empty. replacement may retain and reorder
// owned nodes, but releases every node left outside the next range.
function setChild(marker, after, value) {
  const parent = marker.parentNode;
  if (!parent) return after;

  const previous = after === marker ? [] : collectRange(marker.nextSibling, after),
    isPrimitive = value == null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean',
    text = isPrimitive && value != null && value !== false ? String(value) : '';

  if (text && previous.length === 1 && previous[0].nodeType === 3) {
    setText(previous[0], text);
    return after;
  }

  const next = text
    ? [getOwnerDocument(parent).createTextNode(text)]
    : isPrimitive
      ? []
      : [...new Set(toNodes(value))],
    retained = new Set(next);

  let before = marker.nextSibling;
  for (const node of next) {
    if (node === before) before = before.nextSibling;
    else parent.insertBefore(node, before);
  }
  for (const node of previous)
    if (!retained.has(node)) node.parentNode?.removeChild(node);

  return next.at(-1) ?? marker;
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function isVoidElement(tag) {
  return VOID_ELEMENTS.has(tag.toLowerCase());
}

/** @type {Builder<Node, DocumentFragment>} */
export const DOMBuilder = {
  compile(strings) {
    return compileTemplate(strings, this);
  },

  createRoot() {
    return getGlobalDocument().createDocumentFragment();
  },

  decodeStatic(value) {
    return decodeEntities(value);
  },

  createElement(tag) {
    return getGlobalDocument().createElement(tag);
  },

  createText(text) {
    return getGlobalDocument().createTextNode(text);
  },

  createMarker() {
    return getGlobalDocument().createComment('');
  },

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
  },

  unsetProp(node, name) {
    if (shouldSetProperty(node, name)) {
      node[name] = null;
      return;
    }

    node.removeAttribute(name);
  },

  clone(root) {
    return root.cloneNode(true);
  },

  resolve(root, path) {
    let node = root;
    for (const index of path) node = node.childNodes[index];
    return node;
  },

  isContainer(node) {
    return !!node && (
      node.nodeType === 1 ||
      node.nodeType === 11
    );
  },

  firstChild(container) {
    return container.firstChild;
  },

  lastChild(container) {
    return container.lastChild;
  },

  parent(node) {
    return node.parentNode ?? null;
  },

  contains(container, node) {
    return typeof container?.contains === 'function'
      ? container.contains(node)
      : false;
  },

  insert(parent, child, before = null) {
    if (before) {
      parent.insertBefore(child, before);
      return;
    }

    parent.append(child);
  },

  extract(start, end) {
    if (start === end) {
      start.parentNode?.removeChild(start);
      return start;
    }

    const document = getOwnerDocument(start),
      range = document.createRange();

    range.setStartBefore(start);
    range.setEndAfter(end);
    return range.extractContents();
  },

  remove(start, end) {
    removeRange(start, end);
  },

  next(node) {
    return node.nextSibling ?? null;
  },

  prev(node) {
    return node.previousSibling ?? null;
  },

  isVoidElement,

  setChild,

  toNode,

  toNodes,

  collectRange,
};

/** @type {Builder<Node, DocumentFragment>} */
export const SVGBuilder = {
  ...DOMBuilder,
  isVoidElement() {
    return false;
  },
  createElement(tag) {
    return getGlobalDocument().createElementNS(SVG_NAMESPACE, tag);
  },
};
