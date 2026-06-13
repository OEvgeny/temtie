# ꙋ temtie

**Template calls that remember their place and update from there.**

Temtie is an immediate-mode template runtime. You call tagged templates
from ordinary JavaScript, those calls record a target's next shape, and
`commit()` applies the recorded pass to the medium.

```js
import { mount, capture, commit } from 'temtie/core.js';
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

  for (const item of items) {
    list.html`<li #key${item}>${item}</li>`;
  }

  commit(app);
}

render();
```

The render language is JavaScript including, but not limited to loops, branches,
functions, generators etc.

## Mounts And Captures

`mount(container, { builders })` creates a target seated on a container.

```js
const app = mount(document.body, { builders: { html: DOMBuilder } });
app.html`<main>Hello</main>`;
commit(app);
```

`capture()` creates a free target reference. It gets builder channels when it is
interpolated into a template slot.

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

During commit touched targets are flushed from the passed one, so in this case
the shell doesn't re-run when the clock commits.

## Template slots

Child targets write child content:

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

Fresh spread object must be used when values change. Mutating and reusing 
the same bag is invisible to the diffing step.

Captures can occupy child slots and prop slots allowing passing content as props:

```js
const pane = capture();

root.html`<section>${pane}</section>`;
pane.html`<p>child target</p>`;

root.html`<widget view=${pane}></widget>`;
// the prop receives pane's output
```

Spread slots cannot host targets or value contracts.

## Skip And Reset

`skip(target)` voids an uncommitted pass. The committed output remains, and
nothing staged by the skipped pass is released.

```js
try {
  content.html`<article>${smh}</article>`;
  thisThrows();
  content.html`...`;
} catch (error) {
  skip(content);
  errors.html`<pre>${error.message}</pre>`;
  content.html`${smh}`; // nested targets can be recovered
}

commit(app);
```

`reset(target)` stages emptiness. The next `commit(target)` clears that target.
If you render into it again before committing, segments can still be borrowed.

```js
reset(list);
commit(list); // list is now empty
```

## Builders

Temtie renders through builders. A builder owns parsing products, node/range
movement, property writes, and child writes.

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

The parser is intentionally small and strict.

- Dynamic attributes are unquoted: `class=${name}`.
- Quoted dynamic attributes are rejected: `class="${name}"`.
- Spread props use `...${props}` inside an opening tag.
- `#key${value}` keys a root element segment scoped to template.
- Text in child slots is text, not HTML.

## API

### `mount(container, { builders })`

Creates a mounted target and returns its instance. `builders` maps channel names
to builder objects.

### `capture()`

Creates a free target reference. It receives channels once it is interpolated into a
slot that can host it.

### `commit(target)`

Settles the recorded pass for a target and staged/moved children into it.

### `skip(target)`

Voids the target instance's currently staged pass. Committed output stands.

### `reset(target)`

Stages an empty pass. The next commit clears the instance.

## License

MIT
