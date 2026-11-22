/* ꙋ temtie · builder · dom.js */
/// <reference path="../types.d.ts" />
/** @import { Builder, TemplateBuilder } from 'temtie' */

import { compileTemplate } from '../parser.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TEMTIE_PROP_NAMES = Symbol.for('temtie.propNames');

function isDomNode(value) {
  return !!value && typeof value === 'object' && typeof value.nodeType === 'number';
}

const isHandler = (name, value) => typeof name === 'string' && name.startsWith('on') && typeof value === 'function';
const isDirectProp = (node, name) => typeof name === 'symbol' || !!node?.[TEMTIE_PROP_NAMES]?.has(name);

const asText = (value) => (value == null ? '' : String(value));
const FORM_PROPS = new Map([
  ['input', new Map([['value', asText], ['checked', Boolean], ['indeterminate', Boolean]])],
  ['textarea', new Map([['value', asText]])],
  ['option', new Map([['selected', Boolean]])],
]);

function canWriteProp(node, name) {
  for (let obj = node; obj; obj = Object.getPrototypeOf(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, name);
    if (desc) return desc.set ? true : !!desc.writable && (obj === node || Object.isExtensible(node));
  }
  return Object.isExtensible(node);
}

function clearDynamicProp(node, name) {
  if (!(name in node) || !canWriteProp(node, name)) return;
  const cur = node[name];
  if (isHandler(name, cur) || isDomNode(cur)) node[name] = null;
}

function writeProp(node, name, value) {
  if (isDirectProp(node, name) || isHandler(name, value) || isDomNode(value)) {
    node[name] = value ?? null;
    return;
  }

  // a handler or node the name held gives way to the attribute
  clearDynamicProp(node, name);
  DOMTemplateBuilder.prototype.setProp(node, name, value);
}

function deleteProp(node, name) {
  if (isDirectProp(node, name)) node[name] = null;
  else clearDynamicProp(node, name);
  if (typeof name === 'string') node.removeAttribute(name);
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

  // <svg> opens the SVG namespace and its descendants inherit it; children
  // of <foreignObject> return to HTML. a builder's default namespace applies
  // to top-level elements without a parent namespace
  createElement(tag, parent) {
    const parentNs = parent?.namespaceURI;
    const ns = parentNs
      ? (parentNs === SVG_NAMESPACE && parent.localName === 'foreignObject' ? null : parentNs)
      : this.#owner.namespace;
    return tag === 'svg' || ns === SVG_NAMESPACE
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

/**
 * @implements {Builder<Node, DocumentFragment>}
 * @implements {TemplateBuilder<Node, DocumentFragment>}
 */
export class DOMBuilder extends DOMTemplateBuilder {
  static TemplateBuilder = DOMTemplateBuilder;
  static namespace = null;
  document;
  namespace;
  #templateBuilder;

  constructor(document = globalThis.document, { namespace = undefined } = {}) {
    super();
    this.document = document;
    this.namespace = namespace !== undefined ? namespace : this.constructor.namespace;
    this.#templateBuilder = new this.constructor.TemplateBuilder(this);
  }

  compile(strings) {
    return { ...compileTemplate(strings, this.#templateBuilder), builder: this };
  }

  setProp(node, name, value) {
    const coerce = FORM_PROPS.get(node?.localName)?.get(name);
    if (coerce) {
      const next = coerce(value);
      if (coerce !== asText || node[name] !== next) node[name] = next;
    } else writeProp(node, name, value);
  }

  unsetProp(node, name) {
    const coerce = FORM_PROPS.get(node?.localName)?.get(name);
    if (coerce) {
      node[name] = coerce(null);
      node.removeAttribute(name);
    } else deleteProp(node, name);
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

  // strict text write into the hole's permanent Text anchor
  setChild(anchor, value) {
    anchor.data = value == null || value === false ? '' : String(value);
  }
}

export class SVGBuilder extends DOMBuilder {
  static namespace = SVG_NAMESPACE;
  static voidElements = new Set();

  setProp(node, name, value) {
    writeProp(node, name, value);
  }

  unsetProp(node, name) {
    deleteProp(node, name);
  }
}

export const dom = new DOMBuilder();
export const svg = new SVGBuilder();
