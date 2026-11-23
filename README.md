# ꙋ temtie

**Immediate-mode templates that remember their place in the DOM.**

You write ordinary JavaScript — loops, `if` statements, functions — and call
tagged templates. Those calls only record a draft; nothing touches the DOM 
until you call `commit()`. When you do, Temtie updates existing nodes in place,
moves reordered items with minimal DOM mutations, and removes anything
the new pass left out.

There is no virtual DOM, no build-time compiler, and no reactive primitives.

```js
import { mount, capture, commit, reset } from 'temtie/core.js';
import { dom } from 'temtie/builder/dom.js';

const app = mount(document.body, { html: dom });
const list = capture();

let items = ['Write templates', 'Commit changes'];

function add(text) {
  items = [...items, text];
  render();
}

function render() {
  app.html`
    <main>
      <h1>Tasks (${items.length})</h1>
      <button onclick=${() => add(`Task ${items.length + 1}`)}>Add</button>
      <ul>${list}</ul>
    </main>
  `;

  reset(list); // clear before looping so an empty array renders zero rows
  for (const item of items) {
    list.html`<li #key${item}>${item}</li>`;
  }

  commit(app);
}

render();
```

## How It Works

Three rules explain almost everything in Temtie:

1. **Call sites keep their identity.** Calling the same tagged template literal
   again reuses the DOM nodes it created last time and updates only the values
   that changed. Inside a loop, `#key${id}` ties a row to an ID instead of its
   position so reordering moves existing nodes instead of rebuilding them.
2. **Staging is inert.** Calling ``capture.html`...` `` only records a draft.
   It does not mutate the DOM or trigger side effects, so you can abandon
   a half-written pass with `discard()`, leaving the live DOM untouched.
3. **`commit(capture)` settles in three phases:**
   - **Plan**: expands any value contracts, resolves capture moves, and checks
     for cycles without touching the DOM. If anything throws here,
     nothing on screen changes.
   - **Apply**: removes dropped segments, moves reordered segments minimally
     (using longest increasing subsequence), and writes changed slots.
   - **Effects**: runs `release()` on departing contracts first, then runs
     `commit()` hooks post-order (children before parents).

## Mounts And Captures

`mount(container, { html, svg })` attaches a root capture to a container. Each passed
builder becomes a tagged-template channel on every capture under that root.

```js
const app = mount(document.body, { html: dom });
app.html`<main>Hello</main>`;
commit(app);
```

`capture()` creates a standalone capture target you can place inside a template slot.
Once anchored, it inherits the same channels and can be committed on its own
without re-rendering its parent:

```js
const shell = mount(document.body, { html: dom });
const clock = capture();

shell.html`<header>${clock}</header><main>Dashboard</main>`;
commit(shell);

setInterval(() => {
  clock.html`<time>${new Date().toLocaleTimeString()}</time>`;
  commit(clock); // only updates the clock; shell does not re-run
}, 1000);
```

Captures you do not touch in a pass keep their committed output. Because a `for`
loop over an empty array makes zero calls, call `reset(list)` beforehand when
empty should mean "remove all rows" — any rows the loop *does* emit still reuse
their existing DOM nodes.

## Updating, Amending, And Discarding

Temtie gives you three explicit draft controls between renders and `commit()`:

- **`reset(target)`** starts a fresh replacement pass (staging emptiness). Any
  segments you emit before `commit()` still reuse existing nodes by call site
  and `#key`; anything you omit is removed on commit.
- **`amend(target)`** updates only the segments you touch (and appends any new
  ones) without dropping untouched segments. Useful for updating `n` keyed rows
  in a large list in O(n) time:

```js
// Create one call site so amend() targets the same keyed segments
const renderRow = (row) => list.html`<li #key${row.id}>${row.text}</li>`;

// Full render
function renderAll(rows) {
  reset(list);
  for (const row of rows) renderRow(row);
  commit(list);
}

// Patch a single row without iterating the whole list
function updateRow(row) {
  amend(list);
  renderRow(row);
  commit(list);
}
```

- **`discard(target)`** cancels the current uncommitted draft so the committed
  DOM stays as it was, e.g. for error recovery:

```js
try {
  content.html`<article>${panel}</article>`;
  renderPanel(panel); // might throw
} catch (error) {
  discard(content);
  banner.html`<pre>${error.message}</pre>`;
}

commit(app);
```

## Slots And Template Syntax

Templates support three kinds of slots:

- **Child slots** (`<p>${text}</p>`): plain values write directly into a single
  text node (never parsed as HTML, no extra comment markers). `null`,
  `undefined`, and `false` write empty text.
- **Attribute / property slots** (`<button disabled=${locked} onclick=${save}>`):
  on `DOMBuilder`, `on*` functions bind directly as properties, standard form
  properties (`value`, `checked`, `indeterminate`, `selected`) sync directly,
  booleans toggle attributes, and other values write via `setAttribute`.
- **Spread slots** (`<input ...${props}>`): diffs keys against the previous
  bag and removes omitted keys. Pass a new object when props change — mutating
  the same object in place is treated as unchanged.

Captures can be placed in both child slots and attribute/property slots (passing
rendered fragments as props). Spread slots only accept plain prop objects.

### Syntax Rules

The template parser is deliberately small and strict — malformed templates throw
a `SyntaxError` at compile time:

- Dynamic attributes must be unquoted: `class=${name}` (not `class="${name}"`).
- Spreads use exact `...${props}` inside an opening tag.
- `#key${value}` pins segment identity in loops; it must sit on a root element
  of the template and is never written to the DOM. `undefined`, `null`, `true`,
  and `false` carry no key identity (`0`, `''`, and `NaN` do).
- Tag names start with an ASCII letter; attribute names may keep prefixes like
  `.value`, `@click`, or `?disabled` for custom builders.
- Templates compile once per call site per builder and are cached.

<!-- 
## Extending Slots With Value Contracts

Core stays small by giving userland a single extension point: any object or
function carrying `[Symbol.for('temtie.value')]` is treated as a **value
contract**.

The symbol points to a static descriptor `{ stage?, commit?, release? }` (or a
bare function as shorthand for `{ stage }`; TypeScript users can import
`import type { ValueDescriptor } from 'temtie'`). Keep descriptors stable
across passes — the descriptor identity keeps the claim alive in that hole —
and pass fresh, immutable payload objects when values change. All contract
callbacks are synchronous, and `prev` is the retained previous payload value,
not a deep snapshot:

- **`stage(target, prev, next)`** runs in the **Plan** phase (DOM-free). Use it
  to stage child templates into `target` or skip work when `prev` matches
  `next`. `prev` is `undefined` on first mount and only advances once the
  target's writes and descendants finish applying. Failed Plan work is
  abandoned before touching the DOM; Apply and Effects do not provide general
  rollback.
- **`commit(handle, prev, next)`** runs in the **Effects** phase (post-order,
  after the DOM is updated and departing claims have released). `handle` gives
  you `{ kind, builder, node, marker, prop, name, target }` plus `handle.set()`
  (for writable slots) and `handle.range()` (for managing multi-node ranges in
  child slots). `handle.target` is lazy — hole-only contracts allocate no child
  target unless you touch it.
- **`release(handle, current)`** runs when the claim leaves the hole or its
  segment is dropped, before any arriving `commit()` runs.

```js
/** @import { ValueDescriptor } from 'temtie' */

const VALUE = Symbol.for('temtie.value');

// Example 1: element ref (runs in Effects, no child target allocated)
/** @type {ValueDescriptor} */
const REF = {
  commit(handle, prev, next) {
    if (prev && prev.fn !== next.fn) prev.fn(null);
    next.fn(handle.node);
  },
  release(_handle, cur) {
    cur.fn(null);
  },
};
const ref = (fn) => ({ [VALUE]: REF, fn });

// Example 2: memoized subtree (runs in Plan; failed Plan work is abandoned)
/** @type {ValueDescriptor} */
const MEMO = {
  stage(target, prev, next) {
    if (prev && prev.key === next.key) return;
    reset(target);
    next.render(target);
  },
};
const memo = (key, render) => ({ [VALUE]: MEMO, key, render });

function render(count) {
  app.html`<div ref=${ref((el) => console.log(el))}>${memo(count, (t) => t.html`<b>${count}</b>`)}</div>`;
  commit(app);
}

render(1);
```

A few guardrails built into contracts:
- A contract cannot both stage templates into `target` and write directly
  through `handle.set()` / `handle.range()`.
- `commit()` and handle writes are rejected while a commit is in Plan/Apply.
- Same-claim reentry (a `commit()` synchronously triggering another `commit()`
  that updates or removes itself) is rejected in Plan. -->

## Builders: DOM, SVG, And Markup

Temtie never touches browser globals directly — all node creation, movement, and
property writes go through a builder (`import type { Builder } from 'temtie'`).

### DOM & SVG

`dom` and `svg` are ready-to-use instances of `DOMBuilder` and `SVGBuilder`
bound to `globalThis.document`. Pass a custom `document` (for iframes or test
DOMs) by instantiating the classes directly:

```js
import { mount, commit } from 'temtie/core.js';
import { DOMBuilder, SVGBuilder, dom, svg } from 'temtie/builder/dom.js';

const app = mount(document.body, { html: dom, svg });
app.html`<button>Click</button>`;
app.svg`<svg viewBox="0 0 10 10"><circle r=${4}></circle></svg>`;
commit(app);

// Isolated document (e.g. iframe)
const frameDoc = document.querySelector('iframe').contentDocument;
const frameApp = mount(frameDoc.body, {
  html: new DOMBuilder(frameDoc),
  svg: new SVGBuilder(frameDoc),
});
```

Inside `DOMBuilder`, `<svg>` automatically switches children to the SVG
namespace and `<foreignObject>` switches back to HTML. `DOMBuilder.voidElements`
and `SVGBuilder.voidElements` are mutable `Set`s you can copy/customize in a
subclass.

### Markup (SSR / Headless)

`temtie/builder/markup.js` renders into a lightweight plain-JS tree and
serializes to HTML strings on demand:

```js
import { mount, commit } from 'temtie/core.js';
import { markup, serialize } from 'temtie/builder/markup.js';

const root = markup.createRoot();
const page = mount(root, { html: markup });

page.html`<article><h1>${'Hello <world>'}</h1></article>`;
commit(page);

serialize(root); // '<article><h1>Hello &lt;world&gt;</h1></article>'
```

## Debugging

`temtie/debug.js` is a lightweight event hub that emits structured lifecycle
events (`mount`, `call`, `stage`, `claim`, `write`, `move`, `drop`, `commit`,
`flush`, `place`, `sealed`, `settled`, `end`, `dispose`, `compile`, `compiled`,
`assert-failed`). When no listener is attached, event objects are not allocated.

```js
import debug from 'temtie/debug.js';

const off = debug.on((ev) => console.log(ev.seq, ev.cause, ev.type));

// Measure commit duration via performance.measure()
const stopMeter = debug.meter({ 'temtie:commit': ['commit', 'settled'] });

// Optional: permanently detach listeners in production builds
debug.disable();
```

Set `debug.stacks = true` to include captured call stacks on `stage` and
`commit` events.

## API Reference

### `temtie/core.js`

- **`mount(container, builders)`** — mounts a root target on `container` using
  the `{ [channel]: builder }` map and returns its target instance.
- **`capture()`** — creates a free target reference; gains builder channels once
  interpolated into a child or attribute slot.
- **`commit(target)`** — runs Plan → Apply → Effects for `target` and all staged
  or moved descendants under it.
- **`reset(target)`** — stages an empty replacement pass (next `commit()` clears
  anything not re-emitted).
- **`amend(target)`** — starts an incremental pass that updates touched segments
  and appends new ones without dropping untouched segments.
- **`discard(target)`** — cancels the uncommitted draft on `target`, keeping the
  committed output intact.
- **`TEMPLATE_HOLE_TYPES`** — `{ CHILD, ATTR, SPREAD, META }` constants for
  custom template compilers/builders.

## License

MIT
