/* ꙋ temtie · builder · dom.js */
/** @import { Builder, TemplateBuilder } from '../types.d.ts' */

import { compileTemplate } from '../parser.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEMTIE_PROP_NAMES = Symbol.for('temtie.propNames');
// marks a text node setChild made from a value: only such a node is its to
// rewrite in place. an adopted Text node is the caller's
const OWN_TEXT = Symbol('temtie.ownText');
const OWNED = Symbol('temtie.owned');

function isDomNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

function toNodes(builder, value) {
  if (value == null || value === false) return [];
  if (isDomNode(value))
    return value.nodeType === 11 ? Array.from(value.childNodes) : [value];
  if (typeof value !== 'string' && typeof value[Symbol.iterator] === 'function')
    return Array.from(value, (item) => toNodes(builder, item)).flat();
  return [builder.createText(String(value))];
}

const isHandler = (name, value) => typeof name === 'string' && name.startsWith('on') && typeof value === 'function';

const asText = (value) => value ?? '';
const FORM_PROPS = new Map([
  ['input', new Map([['value', asText], ['checked', Boolean], ['indeterminate', Boolean]])],
  ['textarea', new Map([['value', asText]])],
  ['select', new Map([['value', asText], ['selectedIndex', (value) => value ?? -1]])],
  ['option', new Map([['selected', Boolean]])],
]);

function shouldSetProperty(node, name, value) {
  return typeof name === 'symbol'
    || isHandler(name, value)
    || isDomNode(value)
    || node?.[TEMTIE_PROP_NAMES]?.has(name);
}

function writeProp(node, name, value) {
  if (shouldSetProperty(node, name, value)) {
    node[name] = value ?? null;
    return;
  }

  // a handler or node the name held gives way to the attribute
  if (isHandler(name, node[name]) || isDomNode(node[name])) node[name] = null;
  DOMTemplateBuilder.prototype.setProp(node, name, value);
}

/** @implements {TemplateBuilder<Node, DocumentFragment>} */
class DOMTemplateBuilder {
  #decoder = null;
  #owner;

  static voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

  constructor(owner) {
    this.#owner = owner ?? this;
  }

  get document() {
    return this.#owner.document;
  }

  createRoot() {
    return this.document.createDocumentFragment();
  }

  decodeStatic(value) {
    if (!value.includes('&')) return value;
    if (this.#decoder?.ownerDocument !== this.document)
      this.#decoder = this.document.createElement('textarea');
    this.#decoder.innerHTML = value;
    return this.#decoder.value;
  }

  // <svg> opens the SVG namespace and its descendants inherit it; the children
  // of a <foreignObject> are HTML again
  createElement(tag, parent) {
    return tag === 'svg' || (parent?.namespaceURI === SVG_NAMESPACE && parent.localName !== 'foreignObject')
      ? this.document.createElementNS(SVG_NAMESPACE, tag)
      : this.document.createElement(tag);
  }

  createText(text) {
    return this.document.createTextNode(text);
  }

  createMarker() {
    return this.document.createComment('');
  }

  // static template attributes stay on attributes so cloneNode(true) preserves them
  setProp(node, name, value) {
    if (value === true)
      node.setAttribute(name, '');
    else if (value === false || value == null)
      node.removeAttribute(name);
    else
      node.setAttribute(name, String(value));
  }

  clone(root) {
    return root.cloneNode(true);
  }

  resolve(root, path) {
    let node = root;
    for (const index of path) node = node.childNodes[index];
    return node;
  }

  firstChild(container) {
    return container.firstChild;
  }

  lastChild(container) {
    return container.lastChild;
  }

  insert(parent, content, after = null) {
    if (after != null && after.parentNode !== parent)
      throw new Error('temtie/builder/dom: insert anchor must belong to its container');
    parent.insertBefore(content, after?.nextSibling ?? null);
  }

  isVoidElement(tag) {
    return this.#owner.constructor.voidElements.has(tag.toLowerCase());
  }
}

class SVGTemplateBuilder extends DOMTemplateBuilder {
  createElement(tag) {
    return this.document.createElementNS(SVG_NAMESPACE, tag);
  }
}

/**
 * @implements {Builder<Node, DocumentFragment>}
 * @implements {TemplateBuilder<Node, DocumentFragment>}
 */
export class DOMBuilder extends DOMTemplateBuilder {
  static TemplateBuilder = DOMTemplateBuilder;
  document;
  #templateBuilder;

  constructor(document = globalThis.document) {
    super();
    this.document = document;
    this.#templateBuilder = new this.constructor.TemplateBuilder(this);
  }

  compile(strings) {
    return { ...compileTemplate(strings, this.#templateBuilder), builder: this };
  }

  setProp(node, name, value) {
    const coerce = FORM_PROPS.get(node?.localName)?.get(name);
    if (coerce) node[name] = coerce(value);
    else writeProp(node, name, value);
  }

  unsetProp(node, name) {
    const coerce = FORM_PROPS.get(node?.localName)?.get(name);
    if (coerce) node[name] = coerce(null);
    else if (shouldSetProperty(node, name, node[name])) node[name] = null;
    if (typeof name === 'string') node.removeAttribute(name);
  }

  parent(node) {
    return node.parentNode ?? null;
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

  prev(node) {
    return node.previousSibling ?? null;
  }

  // the marker anchors the range and survives every replacement
  setChild(marker, after, value) {
    const parent = marker.parentNode;
    if (!parent) return after;

    const first = after === marker ? null : marker.nextSibling,
      ranges = marker[OWNED],
      text = typeof value === 'string' || typeof value === 'number';
    if (text && first === after && first?.[OWN_TEXT] && !ranges?.has(after)) {
      first.data = String(value);
      return first;
    }

    const next = toNodes(this, value);
    if (text) next[0][OWN_TEXT] = true;

    if (after !== marker) {
      const owned = ranges?.get(after);
      if (owned) {
        if (owned.has(first)) {
          let end = first;
          while (owned.has(end.nextSibling)) end = end.nextSibling;
          this.remove(first, end);
        }
        ranges.delete(after);
        if (!ranges.size) marker[OWNED] = null;
      } else if (first === after && first) {
        this.remove(after, after);
      }
    }

    const before = marker.nextSibling;
    let tail = marker;
    for (const node of next) {
      parent.insertBefore(node, before);
      tail = node;
    }
    if (next.length > 1) (marker[OWNED] ??= new Map()).set(tail, new Set(next));
    return tail;
  }
}

export class SVGBuilder extends DOMBuilder {
  static TemplateBuilder = SVGTemplateBuilder;
  static voidElements = new Set();

  createElement(tag) {
    return this.document.createElementNS(SVG_NAMESPACE, tag);
  }

  setProp(node, name, value) {
    writeProp(node, name, value);
  }

  unsetProp(node, name) {
    if (shouldSetProperty(node, name, node[name])) node[name] = null;
    if (typeof name === 'string') node.removeAttribute(name);
  }
}

export const dom = new DOMBuilder();
export const svg = new SVGBuilder();
