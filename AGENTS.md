# Repository Guidelines

## Project Structure & Module Organization
This repository is organized as a small JavaScript package around call-site
keyed template rendering.

- `view.js`: public view and slot definition API.
- `parser.js`: template parsing and compilation.
- `debug.js`: debug event hub used by the runtime.
- `builder/`: builder implementations. Keep browser DOM behavior in
  `builder/dom.js`.
- `example/`: browser examples. Use examples to show real usage and API shape.
- `types.d.ts`: public TypeScript surface for JavaScript users and editors.

Keep runtime code in the smallest file that owns the concept. Prefer merging
small helper-only modules into the owning file unless the subsystem is meant to
be swappable through package exports or import maps.

## Development Command
The repo uses Node-based tooling through `npm`.

- `npx vite`: start the local Vite dev server for browser-facing examples.

## Coding Style & Naming Conventions
Use ES modules and keep imports relative, for example
`import { compileTemplate } from './parser.js';`.

- Prefer 2-space indentation and semicolons.
- Use `camelCase` for functions and variables, `PascalCase` for classes, and
  `UPPER_SNAKE_CASE` for top-level constants.
- Prefer browser-native APIs and plain JavaScript semantics when they express
  the rule directly.
- Keep comments rare and specific. Do not restate what the code already says.

## Design Direction
Temtie is shaped around one core invariant: template call sites keep identity
and update from their own place.

- Preserve behavior by simplifying toward that invariant.
- Reduce code by unifying concepts, not by extracting ornamental helpers.
- Every branch should pay rent. Every helper should pay rent twice.
- Keep the public API small and explicit.
- Avoid virtual-tree concepts unless they are isolated behind a builder.
- Prefer explicit symbols for extension points over implicit object probing.

## Examples
Examples are the primary way to explain the package at this stage.

- Build examples as usable browser surfaces, not marketing pages.
- Prefer `view()`, `define()`, and builder primitives over direct DOM
  manipulation inside render flows.
- Keep example code close to realistic usage, even when it means showing a
  slightly larger but clearer flow.
- If an example needs state, make the update path visible and easy to follow.

## Commit & Pull Request Guidelines
Use a simple baseline convention.

- Write commit subjects in the imperative mood, for example
  `Simplify slot value protocol`.
- Keep commits scoped to one logical change.
