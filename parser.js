/* ꙋ temtie · parser.js */
/** @import { Builder, Template, Hole } from './types.d.ts' */

import { TEMPLATE_HOLE_TYPES } from './core.js';

export { TEMPLATE_HOLE_TYPES };

// where the scan stands when a static ends. only TEXT and IN_TAG carry over
// a hole; every other mode there is a hole kind or a syntax error
const TEXT = 0, TAG_OPEN = 1, TAG_NAME = 2, IN_TAG = 3, ATTR_NAME = 4,
  ATTR_EQ = 5, ATTR_VALUE = 6, CLOSE_TAG = 7, SELF_CLOSE = 8;

const ERROR = 'temtie/parser syntax error: ';

// ASCII classes: /\s/, and the characters that end a name, /[\s"'<>/=]/
const SPACE = 1, DELIMITER = 2;
const ASCII = new Uint8Array(128);
for (const c of '\t\n\v\f\r ') ASCII[c.charCodeAt(0)] = SPACE | DELIMITER;
for (const c of `"'<>=/`) ASCII[c.charCodeAt(0)] = DELIMITER;

// /\s/ past ASCII
function isWideSpace(c) {
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

function isSpace(c) {
  return c < 128 ? (ASCII[c] & SPACE) !== 0 : isWideSpace(c);
}

function isNameChar(c) {
  return c < 128 ? (ASCII[c] & DELIMITER) === 0 : !isWideSpace(c);
}

function isNameStart(c) {
  return (c < 48 || c > 57) && isNameChar(c);
}

// names under # belong to the core. #key is the only resident, and it
// exists only as a meta hole — nothing in the namespace may reach the
// medium, statically or through a prop hole
function assertCoreName(name, meta) {
  if (name[0] !== '#') return;

  if (!meta)
    throw new SyntaxError(
      name === '#key'
        ? `${ERROR}#key takes an interpolated value: #key\${value}`
        : `${ERROR}unknown reserved prop "${name}"`);

  if (name !== '#key')
    throw new SyntaxError(`${ERROR}unknown reserved meta-prop "${name}"`);
}

function spreadWithoutHole() {
  return new SyntaxError(`${ERROR}spread syntax must be followed by interpolation`);
}

function parseTemplate(strings, builder) {
  const fragment = builder.createRoot(),
    holes = [],
    decodeStatic = builder.decodeStatic?.bind(builder) ?? (value => value),
    isVoidElement = builder.isVoidElement?.bind(builder) ?? (() => false),
    stack = [{ node: fragment, path: [], childIndex: 0, tag: null }];

  let ctx = stack[0],
    pending = null,
    pendingPath = null,
    pendingTag = '',
    attrNames = null,
    metaNames = null,
    lastHoleMarker = null;

  function insertText(text) {
    builder.insert(ctx.node, builder.createText(decodeStatic(text, 'text')));
    ctx.childIndex++;
  }

  function openTag(tag) {
    pending = builder.createElement(tag);
    pendingPath = [...ctx.path, ctx.childIndex];
    pendingTag = tag;
    attrNames = [];
    metaNames = [];
  }

  function placeTag(opens) {
    builder.insert(ctx.node, pending);
    ctx.childIndex++;
    if (opens) stack.push(ctx = { node: pending, path: pendingPath, childIndex: 0, tag: pendingTag });
    pending = null;
  }

  function commitTag() {
    placeTag(!isVoidElement(pendingTag));
  }

  function claimName(names, name, kind) {
    if (names.includes(name))
      throw new SyntaxError(`${ERROR}duplicate ${kind} "${name}" in <${pendingTag}>`);

    names.push(name);
  }

  function setStaticProp(name, value) {
    assertCoreName(name, false);
    claimName(attrNames, name, 'attribute');
    builder.setProp(pending, name, value === true ? value : decodeStatic(value, 'attr'));
  }

  function closeTag(tag) {
    if (stack.length === 1)
      throw new SyntaxError(`${ERROR}stray closing tag </${tag}>`);

    if (ctx.tag !== tag)
      throw new SyntaxError(`${ERROR}mismatched closing tag </${tag}>; expected </${ctx.tag}>`);

    stack.pop();
    ctx = stack[stack.length - 1];
  }

  let mode = TEXT,
    spreadDots = 0,
    quote = '',
    nameStart = -1,
    nameEnd = -1,
    attrStart = 0,
    attrName = '',
    valueStart = 0,
    part = '';

  for (let i = 0; i < strings.length; i++) {
    part = strings[i];
    const length = part.length;
    let j = 0;

    // each case consumes a run, not a character; when a run reaches the end of
    // the static, `mode` says what was cut. TAG_NAME and ATTR_NAME only ever
    // mean "cut" — the hole that follows is answered below, never here
    while (j < length) {
      switch (mode) {
        case TEXT: {
          let end = part.indexOf('<', j);
          if (end < 0) end = length;
          else mode = TAG_OPEN;

          if (end > j) insertText(part.slice(j, end));
          j = end + 1;
          break;
        }

        case TAG_OPEN: {
          let c = part.charCodeAt(j);
          if (c === 47) {
            mode = CLOSE_TAG;
            nameStart = -1;
            j++;
            break;
          }

          if (!isNameStart(c))
            throw new SyntaxError(`${ERROR}invalid tag start after "<": "${part[j]}"`);

          nameStart = j;
          do j++; while (j < length && isNameChar(c = part.charCodeAt(j)));

          if (j === length) {
            mode = TAG_NAME;
            break;
          }

          const tag = part.slice(nameStart, j);

          if (c === 62) {
            openTag(tag);
            commitTag();
            mode = TEXT;
          } else if (c === 47) {
            openTag(tag);
            mode = SELF_CLOSE;
          } else if (isSpace(c)) {
            openTag(tag);
            spreadDots = 0;
            mode = IN_TAG;
          } else {
            throw new SyntaxError(`${ERROR}invalid character "${part[j]}" in tag name`);
          }

          j++;
          break;
        }

        case IN_TAG: {
          let c = part.charCodeAt(j);

          if (isSpace(c)) {
            if (spreadDots === 3) throw spreadWithoutHole();
            spreadDots = 0;
            do j++; while (j < length && isSpace(part.charCodeAt(j)));
            break;
          }

          if (c === 62 || c === 47) {
            if (spreadDots !== 0) throw spreadWithoutHole();

            if (c === 62) {
              commitTag();
              mode = TEXT;
            } else {
              mode = SELF_CLOSE;
            }

            j++;
            break;
          }

          if (c === 46) {
            if (++spreadDots > 3)
              throw new SyntaxError(`${ERROR}spread syntax uses exactly three dots`);

            j++;
            break;
          }

          if (spreadDots !== 0) {
            if (spreadDots === 3) throw spreadWithoutHole();

            // dots short of a spread open the name: `..x` is a name
            attrStart = j - spreadDots;
            spreadDots = 0;

            if (!isNameChar(c))
              throw new SyntaxError(`${ERROR}invalid character "${part[j]}" in attribute name`);
          } else if (!isNameStart(c)) {
            throw new SyntaxError(`${ERROR}invalid attribute name start "${part[j]}"`);
          } else {
            attrStart = j;
          }

          do j++; while (j < length && isNameChar(c = part.charCodeAt(j)));

          if (j === length) {
            mode = ATTR_NAME;
            break;
          }

          const name = part.slice(attrStart, j);

          if (c === 61) {
            attrName = name;
            mode = ATTR_EQ;
          } else if (c === 62) {
            setStaticProp(name, true);
            commitTag();
            mode = TEXT;
          } else if (c === 47) {
            setStaticProp(name, true);
            mode = SELF_CLOSE;
          } else if (isSpace(c)) {
            setStaticProp(name, true);
          } else {
            throw new SyntaxError(`${ERROR}invalid character "${part[j]}" in attribute name`);
          }

          j++;
          break;
        }

        case ATTR_EQ: {
          const c = part.charCodeAt(j);

          if (isSpace(c)) {
            do j++; while (j < length && isSpace(part.charCodeAt(j)));
          } else if (c === 34 || c === 39) {
            quote = part[j];
            valueStart = ++j;
            mode = ATTR_VALUE;
          } else if (c === 62 || c === 47) {
            throw new SyntaxError(`${ERROR}attribute "${attrName}" is missing a value`);
          } else {
            quote = '';
            valueStart = j++;
            mode = ATTR_VALUE;
          }

          break;
        }

        case ATTR_VALUE: {
          if (quote) {
            const end = part.indexOf(quote, j);
            if (end < 0) {
              j = length;
              break;
            }

            setStaticProp(attrName, part.slice(valueStart, end));
            quote = '';
            mode = IN_TAG;
            j = end + 1;
            break;
          }

          let c = part.charCodeAt(j);
          while (j < length && c !== 62 && c !== 47 && !isSpace(c)) {
            if (c === 60)
              throw new SyntaxError(`${ERROR}invalid "<" inside attribute "${attrName}" value`);

            c = part.charCodeAt(++j);
          }

          if (j === length) break;

          setStaticProp(attrName, part.slice(valueStart, j));

          if (c === 62) {
            commitTag();
            mode = TEXT;
          } else {
            mode = c === 47 ? SELF_CLOSE : IN_TAG;
          }

          j++;
          break;
        }

        case CLOSE_TAG: {
          let c = part.charCodeAt(j);

          if (isSpace(c))
            throw new SyntaxError(`${ERROR}whitespace after "</" is not supported`);

          if (c === 62)
            throw new SyntaxError(`${ERROR}stray closing tag`);

          if (!isNameStart(c))
            throw new SyntaxError(`${ERROR}invalid closing tag name start "${part[j]}"`);

          nameStart = j;
          do j++; while (j < length && isNameChar(c = part.charCodeAt(j)));
          nameEnd = j;

          if (j < length && isSpace(c))
            do j++; while (j < length && isSpace(c = part.charCodeAt(j)));

          if (j === length) break;

          const tag = part.slice(nameStart, nameEnd);
          if (c !== 62)
            throw new SyntaxError(nameEnd < j
              ? `${ERROR}malformed closing tag </${tag}>`
              : `${ERROR}malformed closing tag </${tag}${part[j]}>`);

          closeTag(tag);
          mode = TEXT;
          j++;
          break;
        }

        case SELF_CLOSE: {
          const c = part.charCodeAt(j);

          if (isSpace(c)) {
            do j++; while (j < length && isSpace(part.charCodeAt(j)));
            break;
          }

          if (c !== 62)
            throw new SyntaxError(`${ERROR}malformed self-closing tag`);

          placeTag(false);
          mode = TEXT;
          j++;
          break;
        }
      }
    }

    if (i === strings.length - 1) break;

    // the interpolation after static `i`
    switch (mode) {
      case TEXT: {
        // a child hole is a single marker: a permanent anchor that content
        // lands after, referenced only while the hole has no content to speak for it
        const marker = builder.createMarker();
        builder.insert(ctx.node, marker);
        holes.push({ type: TEMPLATE_HOLE_TYPES.CHILD, slot: i, path: [...ctx.path, ctx.childIndex] });
        if (ctx.node === fragment) lastHoleMarker = marker;
        ctx.childIndex++;
        break;
      }

      case IN_TAG:
        if (spreadDots === 3) {
          holes.push({ type: TEMPLATE_HOLE_TYPES.SPREAD, slot: i, path: pendingPath });
          spreadDots = 0;
          break;
        }

        if (spreadDots !== 0)
          throw new SyntaxError(`${ERROR}spread syntax requires exact \`...\` immediately before interpolation`);

        throw new SyntaxError(`${ERROR}bare interpolation inside a tag is not supported`);

      case ATTR_EQ:
        assertCoreName(attrName, false);
        claimName(attrNames, attrName, 'attribute');
        holes.push({ type: TEMPLATE_HOLE_TYPES.ATTR, slot: i, path: pendingPath, prop: attrName });
        mode = IN_TAG;
        break;

      case ATTR_NAME:
        attrName = part.slice(attrStart);
        assertCoreName(attrName, true);
        claimName(metaNames, attrName, 'metadata');
        holes.push({ type: TEMPLATE_HOLE_TYPES.META, slot: i, path: pendingPath, name: attrName });
        mode = IN_TAG;
        break;

      case ATTR_VALUE:
        if (!quote)
          throw new SyntaxError(`${ERROR}partial interpolation inside unquoted attribute "${attrName}" is not supported`);

        if (valueStart === part.length)
          throw new SyntaxError(`${ERROR}quoted dynamic attribute ${attrName} is not supported; write ${attrName}=\${value} without quotes`);

        throw new SyntaxError(`${ERROR}partial interpolation inside quoted attribute "${attrName}" is not supported`);

      case TAG_OPEN:
        throw new SyntaxError(`${ERROR}interpolation is not allowed immediately after \`<\``);

      case TAG_NAME:
        throw new SyntaxError(`${ERROR}interpolation is not allowed inside tag name "${part.slice(nameStart)}"`);

      case CLOSE_TAG:
        throw new SyntaxError(`${ERROR}interpolation is not allowed inside a closing tag`);

      case SELF_CLOSE:
        throw new SyntaxError(`${ERROR}interpolation is not allowed inside self-closing syntax`);
    }
  }

  switch (mode) {
    case ATTR_VALUE:
      throw new SyntaxError(quote
        ? `${ERROR}unterminated quoted attribute value for "${attrName}"`
        : `${ERROR}unterminated opening tag after attribute "${attrName}"`);

    case ATTR_NAME:
      throw new SyntaxError(`${ERROR}unterminated opening tag while parsing attribute "${part.slice(attrStart)}"`);

    case ATTR_EQ:
      throw new SyntaxError(`${ERROR}attribute "${attrName}" is missing a value`);

    case TAG_OPEN:
      throw new SyntaxError(`${ERROR}unterminated "<" at end of template`);

    case TAG_NAME:
      throw new SyntaxError(`${ERROR}unterminated tag name "${part.slice(nameStart)}"`);

    case IN_TAG:
      throw spreadDots !== 0
        ? spreadWithoutHole()
        : new SyntaxError(`${ERROR}unterminated opening tag <${pendingTag}>`);

    case CLOSE_TAG:
      throw new SyntaxError(`${ERROR}unterminated closing tag </${nameStart < 0 ? '' : part.slice(nameStart, nameEnd)}>`);

    case SELF_CLOSE:
      throw new SyntaxError(`${ERROR}malformed self-closing tag`);
  }

  // hole content lands after its marker, so a template ending in a
  // top-level hole gets a pin: the fragment's last node must stay physical
  // for segment ranges to hold
  if (lastHoleMarker && builder.lastChild(fragment) === lastHoleMarker)
    builder.insert(fragment, builder.createMarker());

  return { fragment, holes };
}

/**
 * @param {readonly Hole[]} holes
 * @returns {number}
 */
function deriveKeySlot(holes) {
  let slot = -1;

  for (const hole of holes) {
    if (hole.type !== TEMPLATE_HOLE_TYPES.META || hole.name !== '#key') continue;

    // a reserved name is never silently dead: #key either keys the segment
    // or refuses to compile
    if (!Array.isArray(hole.path) || hole.path.length !== 1)
      throw new SyntaxError(`${ERROR}#key belongs on a root element of the template`);

    if (slot !== -1)
      throw new SyntaxError(`${ERROR}a template takes a single #key`);

    slot = hole.slot;
  }

  return slot;
}

/**
 * @template {Builder} B
 * @param {TemplateStringsArray} strings
 * @param {B} builder
 * @returns {Template<B>}
 */
export function compileTemplate(strings, builder) {
  if (!builder || (typeof builder !== 'object' && typeof builder !== 'function'))
    throw new TypeError('temtie/parser: compileTemplate requires a builder object');

  if (!strings || (typeof strings !== 'object' && typeof strings !== 'function'))
    throw new TypeError('temtie/parser: compileTemplate requires a template strings object');

  const { fragment, holes } = parseTemplate(strings, builder),
    template = {
      site: strings,
      builder,
      fragment,
      holes,
      keySlot: deriveKeySlot(holes),
    };

  return template;
}
