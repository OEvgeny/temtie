# ꙋ temtie

**Template calls that remember their place and update from there.**

```js
import { view, define } from 'temtie/view.js';
import { DOMBuilder } from 'temtie/builder/dom.js';

const Item = define((root, text) => {
  root.html`<li>${text}</li>`;
});

let items = ['first', 'second'];
let empty = false;

const app = view((root) => {
  const section = root.html`<section></section>`;

  if (empty) {
    section.html`<p>No items yet</p>`;
    return;
  }

  const list = section.html`<ul></ul>`;
  for (const item of items) {
    list.html`${Item(item)}`;
  }
});

app.mount(document.body, { builders: { html: DOMBuilder } });
```

Temtie turns tagged template calls into stable update points. Each call site is
compiled once, then reused on later renders. You write normal JavaScript flow:
loops, conditions, function calls. Temtie keeps the template holes tied to where
they appeared.

No virtual tree. No build step. No separate update language.

## The Idea

Most template systems split the work in two. First you describe output, then a
runtime decides how to diff or mutate it.

Temtie keeps the update path inside the template call itself. When the same
render function runs again, the same template call sites are visited. The
library reuses those sites and updates their slots.

```js
const Row = define((root, item) => {
  root.html`<li>${item.label}</li>`;
});

const app = view((root) => {
  const list = root.html`<ol></ol>`;

  for (const item of items) {
    list.html`${Row(item)}`;
  }
});
```

The `Row(item)` value belongs to the hole where it is placed. On the next
render, that slot receives the next value. If the value is unchanged, the
builder can leave it alone. Otherwise, only that place updates.

## Builders

Temtie renders through builders. A builder is a small object that knows how to
create output, set properties, move ranges, and replace child values.

The DOM builder ships with the package:

```js
import { DOMBuilder, SVGBuilder } from 'temtie/builder/dom.js';

app.mount(document.body, {
  builders: {
    html: DOMBuilder,
    svg: SVGBuilder,
  },
});
```

Each builder becomes a template channel on the root:

```js
root.html`<button>${label}</button>`;
root.svg`<svg><circle r="4"></circle></svg>`;
```

DOM is just one builder target. The same template identity model can be used for
virtual nodes or other output shapes.

## Updates

`update()` schedules a microtask. Multiple calls in the same synchronous turn
collapse into one render.

```js
count++;
app.update();

count++;
app.update();

// The microtask renders once with the final count.
```

Use `render()` when you want to run immediately:

```js
app.render();
```

## Slots

`define()` creates a slot value. Slot values can be placed in child holes.

```js
const Greet = define((root, name) => {
  root.html`<span>Hello, ${name}</span>`;
});

root.html`<p>${Greet('Alice')}</p>`;
```

`define.state()` creates a stateful slot. The init function runs once for the
slot identity and returns a render function.

```js
const Counter = define.state((root, initialLabel = 'Count', start = 0) => {
  let count = start;

  return (label = initialLabel) => {
    root.html`
      <button onclick=${() => {
        count++;
        app.update();
      }}>
        ${label}: ${count}
      </button>
    `;
  };
});

root.html`${Counter('Counter')}`;
```

Plain values including functions still go through the builder.

## API

### `view(render)`

Creates a view. The render callback receives a root with builder channels.

```js
const app = view((root) => {
  root.html`<h1>Hello</h1>`;
});
```

### `app.mount(container, options)`

Attaches the view and performs the first render.

```js
app.mount(document.body, {
  builders: { html: DOMBuilder },
});
```

Options:

- `builders`: required map of template tags to builders.
- `scheduleUpdate`: optional scheduler for `update()`.
- `id`: optional debug identifier.

### `app.render()`

Runs the render function synchronously.

### `app.update()`

Schedules a batched render.

### `define(render)`

Creates a stateless slot definition.

### `define.state(init)`

Creates a stateful slot definition.

## License

MIT
