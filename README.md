# ꙋ temtie

**Template calls that remember their place and update from there.**

Temtie is an immediate-mode template runtime. You call tagged templates from
ordinary JavaScript, those calls record a target's next shape, and `commit()`
applies the recorded pass to the medium.

> No virtual tree, no diff over trees, no compiler, no proxies:<br>
> a template call site *is* its identity, and plain control flow decides what renders.

```js
import { mount, capture, commit, reset } from 'temtie/core.js';
import { DOMBuilder } from 'temtie/builder/dom.js';

const app = mount(document.body, { builders: { html: DOMBuilder } });

let items = ['first', 'second'];

function render() {
  const list = capture();

  app.html`
    <section>
      <h1>Items</h1>
      <ul>${list}</ul>
    </section>
  `;

  reset(list); // emptiness is staged too: no items, no rows
  for (const item of items) {
    list.html`<li #key${item}>${item}</li>`;
  }

  commit(app);
}

render();
```

The render language is JavaScript: loops, branches, functions, generators —
whatever produces the calls produces the page.

## The Model

- **Call sites keep identity.** The same tagged-template call site visited
  again finds its own segment of the medium and updates it in place. In
  loops, `#key${value}` pins a segment to a value instead of a position.
- **Render records.** Channel calls stage a target's next pass. Nothing
  touches the medium while you render — a pass is data until it commits.
- **Commit applies, and settles everything.** `commit(target)` flushes the
  staged pass, parents before children, and one law covers every ending:
  what a pass did not stage leaves the medium and is disposed.

Between record and commit there are two controls: `skip()` voids a staged
pass while the committed output stands, and `reset()` stages emptiness.

## Mounts And Captures

`mount(container, { builders })` creates a target seated on a container.

```js
const app = mount(document.body, { builders: { html: DOMBuilder } });
app.html`<main>Hello</main>`;
commit(app);
```

`capture()` creates a free target reference. It gets builder channels when it
is interpolated into a template slot.

```js
const body = capture();

app.html`<main>${body}</main>`;
body.html`<h1>Dashboard</h1>`;
commit(app);
```

Captured targets are the composition primitive. They let a parent own layout
while a child owns its own update cycle:

```js
const shell = mount(document.body, { builders: { html: DOMBuilder } });
const clock = capture();

shell.html`<header>${clock}</header><main>...</main>`;
commit(shell);

setInterval(() => {
  clock.html`<time>${new Date().toLocaleTimeString()}</time>`;
  commit(clock);
}, 1000);
```

Commit flushes staged targets downward from the one passed, so the shell does
not re-run when the clock commits.

One consequence of "commit settles everything": disposal is scoped to staged
passes, so a target you do not call keeps its committed output. A loop that
may run zero times stages nothing on its target — stage emptiness first, as
the opening example does with `reset(list)`, and the loop's calls rebuild
over it while reusing every segment they borrow.

## Slots

Child slots write child content:

```js
root.html`<p>${message}</p>`;
```

Attribute slots write properties or attributes:

```js
root.html`<button disabled=${locked}>Save</button>`;
```

Spread slots write prop bags:

```js
root.html`<input ...${props}>`;
```

Use a fresh spread object when values change; mutating and reusing the same
bag is invisible to the diffing step.

Captures can occupy child slots and prop slots, which allows passing content
as props:

```js
const pane = capture();

root.html`<section>${pane}</section>`;
pane.html`<p>child target</p>`;

root.html`<widget view=${pane}></widget>`;
// the prop receives pane's output
```

Spread slots cannot host targets or value contracts.

## The Value Contract

A slot value carrying `Symbol.for('temtie.value')` is claimed by the runtime
instead of being written to the medium. The contract is how a value owns
state, a lifecycle, and — when it needs one — its own update cycle:

```js
const VALUE = Symbol.for('temtie.value');

function stopwatch(body) {          // init: runs once per claim
  let seconds = 0;
  const timer = setInterval(() => { // the closure is the instance state
    seconds += 1;
    body.html`<time>${seconds}s</time>`;
    commit(body);                   // its own record → commit cycle
  }, 1000);

  return {
    render: (body) => body.html`<time>${seconds}s</time>`,
    release: () => clearInterval(timer),
  };
}

app.html`<aside>${{ [VALUE]: stopwatch }}</aside>`;
commit(app);
```

The rules:

- `init(body, ...props)` runs once per claim. Its closure is the instance
  state. It returns the hooks — a bare function reads as `{ render }`.
- **Claim identity follows the init function.** The same function in the same
  slot keeps its claim across passes, which is why the parent above can
  re-render freely without restarting the stopwatch. A different init — or a
  plain value — displaces the instance, and `release` fires at the next flush.
- `render(body, ...props)` runs on every pass of the owning target with the
  current props. Work goes through the supplied body, so render-phase code is
  medium-pure by construction.
- `commit(handle)` fires at every flush of the owning segment, `release(handle)`
  when the claim ends. The handle reaches the slot's destination — its
  `set(value)` writes where the slot writes. Its exact shape is still
  settling; read `makeHandle` in `core.js` before leaning on it.
- Props ride the value: `${{ [VALUE]: greet, props: [name] }}`.

## Skip And Reset

`skip(target)` voids an uncommitted pass. The committed output remains, and
nothing staged by the skipped pass is released.

```js
try {
  content.html`<article>${smh}</article>`;
  thisThrows();
} catch (error) {
  skip(content);
  errors.html`<pre>${error.message}</pre>`;
  content.html`${smh}`; // nested targets can be recovered
}

commit(app);
```

`reset(target)` stages emptiness. The next `commit(target)` clears that
target. If you render into it again before committing, segments can still be
borrowed — reset-then-render is a full rebuild that keeps identity.

```js
reset(list);
commit(list); // list is now empty
```

## Builders

Temtie renders through builders and never touches a medium directly. A
builder owns parsing products, node and range movement, property writes, and
child writes — the whole contract is the `Builder` interface in `types.d.ts`.
Anything that can create, move, and write nodes can be a universe.

```js
import { DOMBuilder, SVGBuilder } from 'temtie/builder/dom.js';

const app = mount(document.body, {
  builders: {
    html: DOMBuilder,
    svg: SVGBuilder,
  },
});

app.html`<button>${label}</button>`;
app.svg`<svg><circle r=${4}></circle></svg>`;
commit(app);
```

Each builder key becomes a channel on every target in that universe.

## Template Syntax

The parser is intentionally small and strict — malformed templates throw a
`SyntaxError` at compile, naming the offense.

- Dynamic attributes are unquoted: `class=${name}`.
- Quoted dynamic attributes are rejected: `class="${name}"`.
- Spread props use `...${props}` inside an opening tag.
- `#key${value}` keys the segment; it belongs on a root element of the
  template and never reaches the medium.
- Text in child slots is text, not HTML.
- Whether `<input>` may omit its closing is the builder's call
  (`isVoidElement`); `DOMBuilder` knows HTML's void set.

Templates compile once per call site per builder and are cached.

## Debugging

The runtime narrates itself. `debug.js` is an event hub every phase reports
to — mount, call, stage, claim, write, move, drop, commit, dispose — with
zero cost while nothing listens.

```js
import debug from 'temtie/debug.js';

const off = debug.on((event) => console.log(event.seq, event.type));
```

Events carry `seq` and `cause`, so spans nest: `meter()` pairs them into
`performance.measure` entries for the profiler.

```js
debug.meter({ 'temtie:commit': ['commit', 'settled'] });
```

The full event and hub types are in `types.d.ts`.

## API

### `mount(container, { builders })`

Creates a mounted target and returns its instance. `builders` maps channel
names to builder objects.

### `capture()`

Creates a free target reference. It receives channels once it is interpolated
into a slot that can host it.

### `commit(target)`

Settles the recorded pass for a target and staged or moved children under it.

### `skip(target)`

Voids the target's currently staged pass. Committed output stands.

### `reset(target)`

Stages an empty pass. The next commit clears the target.

The typed surface in `types.d.ts` also covers the `Builder` contract, the
debug hub, and the template compiler (`compileTemplate`, `parseTemplate`,
`clearTemplateCache` from `parser.js`).

## License

MIT
