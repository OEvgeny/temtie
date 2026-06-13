/* ꙋ temtie · parser.js */
/** @import { Builder, Template, Hole } from './types.d.ts' */

import debug from './debug.js';

const TEMPLATE_PARSER_MODES = {
  TEXT: 'TEXT',
  TAG_OPEN: 'TAG_OPEN',
  TAG_NAME: 'TAG_NAME',
  IN_TAG: 'IN_TAG',
  ATTR_NAME: 'ATTR_NAME',
  ATTR_EQ: 'ATTR_EQ',
  ATTR_VALUE: 'ATTR_VALUE',
  CLOSE_TAG: 'CLOSE_TAG',
  SELF_CLOSE: 'SELF_CLOSE',
};

export const TEMPLATE_HOLE_TYPES = {
  CHILD: 'child',
  ATTR: 'attr',
  SPREAD: 'spread',
  META: 'meta',
};

const NAME_DELIMITER_RE = /[\s"'<>/=]/;

function isWhitespace(char) {
  return /\s/.test(char);
}

function isNameStart(char) {
  return !!char && !NAME_DELIMITER_RE.test(char) && char !== '/' && !/[0-9]/.test(char);
}

function isNameChar(char) {
  return !!char && !NAME_DELIMITER_RE.test(char) && char !== '/';
}

export function parseTemplate(strings, builder) {
  const fragment = builder.createRoot(),
    holes = [],
    decodeStatic = builder.decodeStatic ?? (value => value),
    isVoidElement = builder.isVoidElement ?? (() => false),
    stack = [{ node: fragment, path: [], childIndex: 0, tag: null }];

  let mode = TEMPLATE_PARSER_MODES.TEXT,
    textBuffer = '',
    nameBuffer = '',
    pendingNode = null,
    pendingPath = null,
    pendingTagName = '',
    pendingAttrNames = null,
    pendingMetaNames = null,
    attrName = '',
    attrValue = '',
    attrQuote = '',
    closeTagWhitespaceOnly = false,
    spreadDots = 0,
    lastHoleMarker = null;

  function flushText() {
    if (!textBuffer) return;

    const ctx = stack.at(-1);
    builder.insert(
      ctx.node,
      builder.createText(decodeStatic(textBuffer, 'text'))
    );
    ctx.childIndex++;
    textBuffer = '';
  }

  function openPendingTag(tagName) {
    const ctx = stack.at(-1);

    pendingNode = builder.createElement(tagName);
    pendingPath = [...ctx.path, ctx.childIndex];
    pendingTagName = tagName;
    pendingAttrNames = new Set();
    pendingMetaNames = new Set();
  }

  function commitPendingTag() {
    if (!pendingNode)
      throw new SyntaxError('temtie/parser syntax error: missing pending tag to commit');

    if (isVoidElement(pendingTagName)) return commitSelfClosingTag();

    const ctx = stack.at(-1);
    builder.insert(ctx.node, pendingNode);
    ctx.childIndex++;

    stack.push({
      node: pendingNode,
      path: pendingPath,
      childIndex: 0,
      tag: pendingTagName,
    });

    pendingNode = null;
    pendingPath = null;
    pendingTagName = '';
    pendingAttrNames = null;
    pendingMetaNames = null;
    spreadDots = 0;
  }

  function commitSelfClosingTag() {
    if (!pendingNode)
      throw new SyntaxError('temtie/parser syntax error: self-closing tag has no pending element');

    const ctx = stack.at(-1);
    builder.insert(ctx.node, pendingNode);
    ctx.childIndex++;

    pendingNode = null;
    pendingPath = null;
    pendingTagName = '';
    pendingAttrNames = null;
    pendingMetaNames = null;
    spreadDots = 0;
  }

  function assertUniqueName(names, name, namespace) {
    if (names?.has(name))
      throw new SyntaxError(`temtie/parser syntax error: duplicate ${namespace} "${name}" in <${pendingTagName}>`);

    names?.add(name);
  }

  function closeCurrentTag(tagName) {
    if (stack.length === 1)
      throw new SyntaxError(`temtie/parser syntax error: stray closing tag </${tagName}>`);

    const ctx = stack.at(-1);

    if (ctx.tag !== tagName)
      throw new SyntaxError(`temtie/parser syntax error: mismatched closing tag </${tagName}>; expected </${ctx.tag}>`);

    stack.pop();
  }

  // names under # belong to the core. #key is the only resident, and it
  // exists only as a meta hole — nothing in the namespace may reach the
  // medium, statically or through a prop hole
  function assertCoreName(name, meta) {
    if (name[0] !== '#') return;

    if (!meta)
      throw new SyntaxError(
        name === '#key'
          ? 'temtie/parser syntax error: #key takes an interpolated value: #key${value}'
          : `temtie/parser syntax error: unknown reserved prop "${name}"`);

    if (name !== '#key')
      throw new SyntaxError(`temtie/parser syntax error: unknown reserved meta-prop "${name}"`);
  }

  function setStaticProp(name, value) {
    if (!pendingNode)
      throw new SyntaxError(`temtie/parser syntax error: cannot set static attribute "${name}" without an open tag`);

    assertCoreName(name, false);
    assertUniqueName(pendingAttrNames, name, 'attribute');

    const decoded =
      typeof value === 'string'
        ? decodeStatic(value, 'attr')
        : value;

    builder.setProp(pendingNode, name, decoded);
  }

  // a child hole is a single marker: a permanent anchor that content lands
  // after, referenced only while the hole has no content to speak for it
  function emitChildHole(slot) {
    flushText();

    const ctx = stack.at(-1),
      marker = builder.createMarker();
    builder.insert(ctx.node, marker);

    holes.push({
      type: TEMPLATE_HOLE_TYPES.CHILD,
      slot,
      path: [...ctx.path, ctx.childIndex],
    });

    if (ctx.node === fragment) lastHoleMarker = marker;
    ctx.childIndex += 1;
  }

  function emitAttrHole(slot) {
    assertCoreName(attrName, false);
    assertUniqueName(pendingAttrNames, attrName, 'attribute');

    holes.push({
      type: TEMPLATE_HOLE_TYPES.ATTR,
      slot,
      path: pendingPath,
      prop: attrName,
    });

    attrName = '';
    attrValue = '';
    attrQuote = '';
    mode = TEMPLATE_PARSER_MODES.IN_TAG;
  }

  function emitMetaHole(slot) {
    assertCoreName(attrName, true);
    assertUniqueName(pendingMetaNames, attrName, 'metadata');

    holes.push({
      type: TEMPLATE_HOLE_TYPES.META,
      slot,
      path: pendingPath,
      name: attrName,
    });

    attrName = '';
    attrValue = '';
    attrQuote = '';
    mode = TEMPLATE_PARSER_MODES.IN_TAG;
  }

  function emitSpreadHole(slot) {
    holes.push({
      type: TEMPLATE_HOLE_TYPES.SPREAD,
      slot,
      path: pendingPath,
    });

    spreadDots = 0;
  }

  function handleInterpolation(slot) {
    switch (mode) {
      case TEMPLATE_PARSER_MODES.TEXT:
        emitChildHole(slot);
        return;

      case TEMPLATE_PARSER_MODES.IN_TAG:
        if (spreadDots === 3) {
          emitSpreadHole(slot);
          return;
        }

        if (spreadDots !== 0)
          throw new SyntaxError('temtie/parser syntax error: spread syntax requires exact `...` immediately before interpolation');

        throw new SyntaxError('temtie/parser syntax error: bare interpolation inside a tag is not supported');

      case TEMPLATE_PARSER_MODES.ATTR_EQ:
        emitAttrHole(slot);
        return;

      case TEMPLATE_PARSER_MODES.ATTR_NAME:
        emitMetaHole(slot);
        return;

      case TEMPLATE_PARSER_MODES.ATTR_VALUE:
        if (attrQuote) {
          if (!attrValue)
            throw new SyntaxError(`temtie/parser syntax error: quoted dynamic attribute ${attrName} is not supported; write ${attrName}=\${value} without quotes`);

          throw new SyntaxError(`temtie/parser syntax error: partial interpolation inside quoted attribute "${attrName}" is not supported`);
        }
        throw new SyntaxError(`temtie/parser syntax error: partial interpolation inside unquoted attribute "${attrName}" is not supported`);
      case TEMPLATE_PARSER_MODES.TAG_OPEN:
        throw new SyntaxError('temtie/parser syntax error: interpolation is not allowed immediately after `<`');
      case TEMPLATE_PARSER_MODES.TAG_NAME:
        throw new SyntaxError(`temtie/parser syntax error: interpolation is not allowed inside tag name "${nameBuffer}"`);
      case TEMPLATE_PARSER_MODES.CLOSE_TAG:
        throw new SyntaxError('temtie/parser syntax error: interpolation is not allowed inside a closing tag');
      case TEMPLATE_PARSER_MODES.SELF_CLOSE:
        throw new SyntaxError('temtie/parser syntax error: interpolation is not allowed inside self-closing syntax');
    }
  }

  for (let i = 0; i < strings.length; i++) {
    const part = strings[i];

    for (let j = 0; j < part.length; j++) {
      const char = part[j];

      switch (mode) {
        case TEMPLATE_PARSER_MODES.TEXT:
          if (char === '<') {
            flushText();
            mode = TEMPLATE_PARSER_MODES.TAG_OPEN;
            nameBuffer = '';
          } else {
            textBuffer += char;
          }
          break;

        case TEMPLATE_PARSER_MODES.TAG_OPEN:
          if (char === '/') {
            mode = TEMPLATE_PARSER_MODES.CLOSE_TAG;
            nameBuffer = '';
            closeTagWhitespaceOnly = false;
            break;
          }

          if (!isNameStart(char))
            throw new SyntaxError(`temtie/parser syntax error: invalid tag start after "<": "${char}"`);

          nameBuffer = char;
          mode = TEMPLATE_PARSER_MODES.TAG_NAME;
          break;

        case TEMPLATE_PARSER_MODES.TAG_NAME:
          if (isWhitespace(char)) {
            openPendingTag(nameBuffer);
            nameBuffer = '';
            spreadDots = 0;
            mode = TEMPLATE_PARSER_MODES.IN_TAG;
            break;
          }

          if (char === '>') {
            openPendingTag(nameBuffer);
            nameBuffer = '';
            commitPendingTag();
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (char === '/') {
            openPendingTag(nameBuffer);
            nameBuffer = '';
            mode = TEMPLATE_PARSER_MODES.SELF_CLOSE;
            break;
          }

          if (!isNameChar(char))
            throw new SyntaxError(`temtie/parser syntax error: invalid character "${char}" in tag name`);

          nameBuffer += char;
          break;

        case TEMPLATE_PARSER_MODES.IN_TAG:
          if (isWhitespace(char)) {
            if (spreadDots === 3)
              throw new SyntaxError('temtie/parser syntax error: spread syntax must be followed by interpolation');

            spreadDots = 0;
            break;
          }

          if (char === '>') {
            if (spreadDots !== 0)
              throw new SyntaxError('temtie/parser syntax error: spread syntax must be followed by interpolation');

            commitPendingTag();
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (char === '/') {
            if (spreadDots !== 0)
              throw new SyntaxError('temtie/parser syntax error: spread syntax must be followed by interpolation');

            mode = TEMPLATE_PARSER_MODES.SELF_CLOSE;
            break;
          }

          if (char === '.') {
            spreadDots++;
            if (spreadDots > 3)
              throw new SyntaxError('temtie/parser syntax error: spread syntax uses exactly three dots');

            break;
          }

          if (spreadDots !== 0) {
            if (spreadDots === 3)
              throw new SyntaxError('temtie/parser syntax error: spread syntax must be followed by interpolation');

            attrName = '.'.repeat(spreadDots) + char;
            spreadDots = 0;

            if (!isNameChar(char))
              throw new SyntaxError(`temtie/parser syntax error: invalid character "${char}" in attribute name`);

            mode = TEMPLATE_PARSER_MODES.ATTR_NAME;
            break;
          }

          if (!isNameStart(char))
            throw new SyntaxError(`temtie/parser syntax error: invalid attribute name start "${char}"`);

          attrName = char;
          mode = TEMPLATE_PARSER_MODES.ATTR_NAME;
          break;

        case TEMPLATE_PARSER_MODES.ATTR_NAME:
          if (char === '=') {
            attrValue = '';
            attrQuote = '';
            mode = TEMPLATE_PARSER_MODES.ATTR_EQ;
            break;
          }

          if (isWhitespace(char)) {
            setStaticProp(attrName, true);
            attrName = '';
            spreadDots = 0;
            mode = TEMPLATE_PARSER_MODES.IN_TAG;
            break;
          }

          if (char === '>') {
            setStaticProp(attrName, true);
            attrName = '';
            commitPendingTag();
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (char === '/') {
            setStaticProp(attrName, true);
            attrName = '';
            mode = TEMPLATE_PARSER_MODES.SELF_CLOSE;
            break;
          }

          if (!isNameChar(char))
            throw new SyntaxError(`temtie/parser syntax error: invalid character "${char}" in attribute name`);

          attrName += char;
          break;

        case TEMPLATE_PARSER_MODES.ATTR_EQ:
          if (isWhitespace(char)) break;

          if (char === '"' || char === "'") {
            attrQuote = char;
            attrValue = '';
            mode = TEMPLATE_PARSER_MODES.ATTR_VALUE;
            break;
          }

          if (char === '>' || char === '/')
            throw new SyntaxError(`temtie/parser syntax error: attribute "${attrName}" is missing a value`);

          attrQuote = '';
          attrValue = char;
          mode = TEMPLATE_PARSER_MODES.ATTR_VALUE;
          break;

        case TEMPLATE_PARSER_MODES.ATTR_VALUE:
          if (attrQuote) {
            if (char === attrQuote) {
              setStaticProp(attrName, attrValue);
              attrName = '';
              attrValue = '';
              attrQuote = '';
              mode = TEMPLATE_PARSER_MODES.IN_TAG;
            } else {
              attrValue += char;
            }
            break;
          }

          if (isWhitespace(char)) {
            setStaticProp(attrName, attrValue);
            attrName = '';
            attrValue = '';
            mode = TEMPLATE_PARSER_MODES.IN_TAG;
            break;
          }

          if (char === '>') {
            setStaticProp(attrName, attrValue);
            attrName = '';
            attrValue = '';
            commitPendingTag();
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (char === '/') {
            setStaticProp(attrName, attrValue);
            attrName = '';
            attrValue = '';
            mode = TEMPLATE_PARSER_MODES.SELF_CLOSE;
            break;
          }

          if (char === '<')
            throw new SyntaxError(`temtie/parser syntax error: invalid "<" inside attribute "${attrName}" value`);

          attrValue += char;
          break;

        case TEMPLATE_PARSER_MODES.CLOSE_TAG:
          if (!nameBuffer) {
            if (isWhitespace(char))
              throw new SyntaxError('temtie/parser syntax error: whitespace after "</" is not supported');

            if (char === '>')
              throw new SyntaxError('temtie/parser syntax error: stray closing tag');

            if (!isNameStart(char))
              throw new SyntaxError(`temtie/parser syntax error: invalid closing tag name start "${char}"`);

            nameBuffer = char;
            break;
          }

          if (closeTagWhitespaceOnly) {
            if (isWhitespace(char))
              break;

            if (char !== '>')
              throw new SyntaxError(`temtie/parser syntax error: malformed closing tag </${nameBuffer}>`);

            closeCurrentTag(nameBuffer);
            nameBuffer = '';
            closeTagWhitespaceOnly = false;
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (isWhitespace(char)) {
            closeTagWhitespaceOnly = true;
            break;
          }

          if (char === '>') {
            closeCurrentTag(nameBuffer);
            nameBuffer = '';
            mode = TEMPLATE_PARSER_MODES.TEXT;
            break;
          }

          if (!isNameChar(char))
            throw new SyntaxError(`temtie/parser syntax error: malformed closing tag </${nameBuffer}${char}>`);

          nameBuffer += char;
          break;

        case TEMPLATE_PARSER_MODES.SELF_CLOSE:
          if (isWhitespace(char)) break;

          if (char !== '>')
            throw new SyntaxError('temtie/parser syntax error: malformed self-closing tag');

          commitSelfClosingTag();
          mode = TEMPLATE_PARSER_MODES.TEXT;
          break;
      }
    }

    if (i < strings.length - 1) handleInterpolation(i);
  }

  if (mode === TEMPLATE_PARSER_MODES.TEXT)
    flushText();
  else if (mode === TEMPLATE_PARSER_MODES.ATTR_VALUE && attrQuote)
    throw new SyntaxError(`temtie/parser syntax error: unterminated quoted attribute value for "${attrName}"`);
  else if (mode === TEMPLATE_PARSER_MODES.ATTR_NAME)
    throw new SyntaxError(`temtie/parser syntax error: unterminated opening tag while parsing attribute "${attrName}"`);
  else if (mode === TEMPLATE_PARSER_MODES.ATTR_EQ)
    throw new SyntaxError(`temtie/parser syntax error: attribute "${attrName}" is missing a value`);
  else if (mode === TEMPLATE_PARSER_MODES.ATTR_VALUE)
    throw new SyntaxError(`temtie/parser syntax error: unterminated opening tag after attribute "${attrName}"`);
  else if (mode === TEMPLATE_PARSER_MODES.TAG_OPEN)
    throw new SyntaxError('temtie/parser syntax error: unterminated "<" at end of template');
  else if (mode === TEMPLATE_PARSER_MODES.TAG_NAME)
    throw new SyntaxError(`temtie/parser syntax error: unterminated tag name "${nameBuffer}"`);
  else if (mode === TEMPLATE_PARSER_MODES.IN_TAG)
    if (spreadDots !== 0)
      throw new SyntaxError('temtie/parser syntax error: spread syntax must be followed by interpolation');
    else
      throw new SyntaxError(`temtie/parser syntax error: unterminated opening tag <${pendingTagName}>`);
  else if (mode === TEMPLATE_PARSER_MODES.CLOSE_TAG)
    throw new SyntaxError(`temtie/parser syntax error: unterminated closing tag </${nameBuffer}>`);
  else if (mode === TEMPLATE_PARSER_MODES.SELF_CLOSE)
    throw new SyntaxError('temtie/parser syntax error: malformed self-closing tag');

  // hole content lands after its marker, so a template ending in a
  // top-level hole gets a pin: the fragment's last node must stay physical
  // for segment ranges to hold
  if (lastHoleMarker && builder.lastChild(fragment) === lastHoleMarker)
    builder.insert(fragment, builder.createMarker());

  return { fragment, holes };
}

let TEMPLATE_CACHE = new WeakMap();

/**
 * @param {readonly Hole[]} holes
 * @returns {number}
 */
export function deriveKeySlot(holes) {
  let slot = -1;

  for (const hole of holes) {
    if (hole.type !== TEMPLATE_HOLE_TYPES.META || hole.name !== '#key') continue;

    // a reserved name is never silently dead: #key either keys the segment
    // or refuses to compile
    if (!Array.isArray(hole.path) || hole.path.length !== 1)
      throw new SyntaxError('temtie/parser syntax error: #key belongs on a root element of the template');

    if (slot !== -1)
      throw new SyntaxError('temtie/parser syntax error: a template takes a single #key');

    slot = hole.slot;
  }

  return slot;
}

/**
 * @template {Builder} B
 * @param {TemplateStringsArray} strings
 * @param {B} builder
 * @param {{ vctx?: object | null, pass?: number }} [options]
 * @returns {Template<B>}
 */
export function compileTemplate(strings, builder, options = {}) {
  if (!builder || (typeof builder !== 'object' && typeof builder !== 'function'))
    throw new TypeError('temtie/parser: compileTemplate requires a builder object');

  if (!strings || (typeof strings !== 'object' && typeof strings !== 'function'))
    throw new TypeError('temtie/parser: compileTemplate requires a template strings object');

  let cache = TEMPLATE_CACHE.get(builder);
  if (!cache) {
    cache = new Map();
    TEMPLATE_CACHE.set(builder, cache);
  }

  const rawKey = strings.raw ? strings.raw.join('\x00') : String(strings),
    cached = cache.get(rawKey);
  if (cached) return cached;

  const ev = debug.enabled && debug.emit({
    type: 'compile',
    builder,
    target: options.vctx ?? null,
    pass: options.pass,
    site: strings,
    html: strings.join('${...}').slice(0, 100),
  });

  const { fragment, holes } = parseTemplate(strings, builder),
    keySlot = deriveKeySlot(holes),
    template = {
      site: strings,
      builder,
      fragment,
      holes,
      keySlot,
      metadata: typeof builder.getTemplateMetadata === 'function'
        ? builder.getTemplateMetadata({ site: strings, fragment, holes, keySlot }) ?? null
        : null,
    };

  cache.set(rawKey, template);

  ev && debug.emit({ type: 'compiled', cause: ev.seq, template });

  return template;
}

export function clearTemplateCache(builder) {
  if (!builder) {
    TEMPLATE_CACHE = new WeakMap();
    return;
  }

  TEMPLATE_CACHE.delete(builder);
}
