# Repository Guidelines

## Project Structure & Module Organization
This repository is organized as a small JavaScript package around immediate-mode
template rendering with explicit record/commit phases.

- `core.js`: public target runtime. Owns `mount`, `capture`, `commit`, `skip`,
  and `reset`.
- `parser.js`: template parsing and compilation.
- `debug.js`: debug event hub used by the runtime.
- `builder/`: builder implementations. Keep browser DOM behavior in
  `builder/dom.js`.
- `types.d.ts`: public TypeScript surface for JavaScript users and editors.
- `README.md`: primary user-facing documentation for the committed API.

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
Temtie is shaped around a few core invariants: template call sites keep
identity, channel calls record a target's next pass, and `commit()` is the
phase that applies the recorded pass to the medium.

- Preserve behavior by simplifying toward that invariant.
- Reduce code by unifying concepts, not by extracting ornamental helpers.
- Every branch should pay rent. Every helper should pay rent twice.
- Keep the public API small and explicit.
- Avoid virtual-tree concepts unless they are isolated behind a builder.
- Prefer explicit symbols for extension points over implicit object probing.

## Documentation
`README.md` is the primary way to explain the package at this stage.

- Keep docs aligned with committed files and APIs only. Do not document
  uncommitted experiments, examples, extensions, or local scratch directories.
- Keep examples in docs close to realistic usage, even when that means showing
  a slightly larger but clearer flow.
- If a documented example needs state, make the record and commit path visible.

## Commit & Pull Request Guidelines
Use a simple baseline convention.

- Write commit subjects in the imperative mood, for example
  `Simplify slot value protocol`.
- Keep commits scoped to one logical change.
