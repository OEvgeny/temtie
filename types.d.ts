/* ꙋ temtie · types.d.ts */

export type PropertyKeyLike = string | number | symbol;

/* Builder contract */
export interface Builder<Node = unknown, Root = Node> {
  // syntax belongs to the builder: compile turns a site's statics into a
  // template. most builders delegate to parser.js's compileTemplate; the
  // core guarantees one call per site and stamps builder/keySlot if absent
  compile(strings: TemplateStringsArray): Template<Builder<Node, Root>>;
  createRoot(): Root;
  decodeStatic?(value: string, context?: 'text' | 'attr'): string;
  isVoidElement?(tag: string): boolean;
  createElement(tag: string): Node;
  createText(text: string): Node;
  createMarker(): Node;
  setProp(node: Node, name: PropertyKeyLike, value: unknown): void;
  unsetProp(node: Node, name: PropertyKeyLike): void;
  clone(root: Root): Root;
  resolve(root: Root, path: readonly number[]): Node;
  isContainer(node: unknown): node is Node | Root;
  firstChild(container: Node | Root): Node | null;
  lastChild(container: Node | Root): Node | null;
  parent(node: Node): Node | Root | null;
  contains(container: Node | Root, node: Node): boolean;
  insert(parent: Node | Root, child: Node | Root, before?: Node | null): void;
  extract(start: Node, end: Node): Node | Root;
  remove(start: Node, end: Node): void;
  next(node: Node): Node | null;
  prev(node: Node): Node | null;
  // `after` is the tail of the range owned after `marker`; marker itself
  // means empty. Core returns it only to this builder and marker. Replacing
  // or clearing the child invalidates the old tail and returns the new one.
  setChild(marker: Node, after: Node, value: Renderable): Node;
  toNode(...values: Renderable[]): Node | Root;
  toNodes(value: Renderable): Node[];
  collectRange(start: Node, end: Node): Node[];
}

export type Builders = object;
export type BuilderKeys<Bs extends Builders> = {
  [Name in keyof Bs]: Bs[Name] extends Builder<any, any> ? Name : never;
}[keyof Bs];
export type AnyBuilderOf<Bs extends Builders> = Extract<Bs[BuilderKeys<Bs>], Builder<any, any>>;
export type BuilderNode<B> = B extends Builder<infer Node, any> ? Node : never;
export type BuilderRoot<B> = B extends Builder<any, infer Root> ? Root : never;
export type RenderContainer<Bs extends Builders> =
  BuilderNode<AnyBuilderOf<Bs>> | BuilderRoot<AnyBuilderOf<Bs>>;

export interface Template<B extends Builder = Builder> {
  readonly site: TemplateStringsArray;
  readonly builder: B;
  readonly fragment: BuilderRoot<B>;
  readonly holes: readonly Hole[];
  readonly keySlot: number;
}

export type Hole =
  | { readonly type: 'child'; readonly slot: number; readonly path: readonly number[] }
  | { readonly type: 'attr'; readonly slot: number; readonly path: readonly number[]; readonly prop: PropertyKeyLike }
  | { readonly type: 'spread'; readonly slot: number; readonly path: readonly number[] }
  | { readonly type: 'meta'; readonly slot: number; readonly path: readonly number[]; readonly name: PropertyKeyLike };

/* Core runtime */
export type Renderable =
  | string
  | number
  | boolean
  | null
  | undefined
  | object
  | Iterable<Renderable>;

// a builder channel: a tagged-template call that stages into its instance.
// the call returns nothing — composition is by interpolating instances (and
// value contracts) into the holes of another call.
export type Channel = (strings: TemplateStringsArray, ...values: Renderable[]) => void;

// a mounted or captured target handle, exposing one channel per builder.
// mount() seats it on a container; capture() makes a free instance whose
// channels resolve once it is interpolated into a hole.
export type Instance<Bs extends Builders = DefaultBuilders> = {
  readonly [Name in BuilderKeys<Bs>]: Channel;
};

// the exported core surface — each signature authored here once, then worn by
// the implementation through a single @type tag and re-exported below
export type Mount = <Bs extends Builders = DefaultBuilders>(
  container: RenderContainer<Bs>,
  options?: { builders?: Bs }
) => Instance<Bs>;
export type Capture = <Bs extends Builders = DefaultBuilders>() => Instance<Bs>;
export type Commit = (instance: Instance<any>) => void;
export type Skip = (instance: Instance<any>) => void;
export type Reset = (instance: Instance<any>) => void;

export function compileTemplate<B extends Builder>(
  strings: TemplateStringsArray,
  builder: B
): Template<B>;

// a live target handle as a listener sees it: the node in the render tree the
// event touched. its remaining fields are core-internal.
export interface DebugTarget {
  readonly parent: DebugTarget | null;
  readonly children: ReadonlySet<DebugTarget>;
  readonly pass: number;
}

export type DebugVia = 'render' | 'skip' | 'reset';

export type DebugOccupant =
  | { readonly kind: 'plain'; readonly after: unknown }
  | { readonly kind: 'body'; readonly body: DebugTarget }
  | { readonly kind: 'instance'; readonly body: DebugTarget; readonly init: Function; readonly after: unknown };

export interface DebugBinding {
  readonly dest: { readonly kind: 'root' | 'child' | 'attr' | 'meta' | 'spread' };
  readonly slot: number;
  readonly node?: unknown;
  readonly marker?: unknown;
  readonly prop?: PropertyKeyLike;
  readonly name?: PropertyKeyLike;
  readonly occupant?: DebugOccupant | null;
}

export interface DebugSegment {
  readonly template: Template;
  readonly pass: number;
}

interface DebugEventBase {
  readonly seq: number; // total order, assigned by the hub
  readonly cause: number; // the enclosing span's seq, 0 at the root
  readonly stack?: Error; // present on stage and commit while debug.stacks is on
}

export type DebugEvent = DebugEventBase & (
  | { type: 'mount'; target: DebugTarget; container: unknown; builders: readonly string[] }
  | { type: 'call'; target: DebugTarget; pass: number; via: DebugVia }
  | { type: 'stage'; target: DebugTarget; pass: number; segment: DebugSegment; template: Template; fresh: boolean; key?: unknown }
  | { type: 'claim' | 'displace' | 'end'; binding: DebugBinding; occupant: DebugOccupant | null }
  | { type: 'write'; binding: DebugBinding; value: unknown }
  | { type: 'deliver'; target: DebugTarget; binding: DebugBinding }
  | { type: 'move'; target: DebugTarget; segment: DebugSegment; container: unknown; after: unknown }
  | { type: 'drop'; target: DebugTarget; segment: DebugSegment }
  | { type: 'commit' | 'flush' | 'place' | 'sealed'; target: DebugTarget; pass: number }
  | { type: 'settled'; target: DebugTarget }
  | { type: 'dispose'; target: DebugTarget }
  | { type: 'compile'; builder: Builder; target: DebugTarget | null; pass?: number; site: TemplateStringsArray; html: string }
  | { type: 'compiled'; template: Template }
  | { type: 'assert-failed'; error: Error; assert?: string }
);

export interface DebugMeterClock {
  now(): number;
  measure(name: string, span: { start: number; end: number }): void;
}

export interface DebugHub {
  enabled: boolean; // true while any listener is attached, or after enable()
  stacks: boolean; // when true, span events carry a captured Error stack
  cause: number; // the enclosing span's seq; emit stamps it where none is given
  on(listener: (event: DebugEvent) => void): () => void;
  disable(): void; // permanently detach and reject listeners for this module instance
  emit<E extends { type: string }>(event: E): E & { seq: number; cause: number };
  assert(condition: unknown, message: string, event?: Record<string, unknown>): void;
  // pair cause-linked span events into performance.measure entries, named by
  // the caller — e.g. meter({ 'temtie:commit': ['commit', 'settled'] })
  meter(spans: Record<string, readonly [start: string, end: string]>, perf?: DebugMeterClock): () => void;
}

/* Default builder set */
export interface DefaultBuilders {
  html: Builder<Node, DocumentFragment>;
  svg: Builder<Node, DocumentFragment>;
}

declare module 'temtie/core.js' {
  export const mount: Mount;
  export const capture: Capture;
  export const commit: Commit;
  export const skip: Skip;
  export const reset: Reset;
  export const TEMPLATE_HOLE_TYPES: {
    readonly CHILD: 'child';
    readonly ATTR: 'attr';
    readonly SPREAD: 'spread';
    readonly META: 'meta';
  };
}

declare module 'temtie/debug.js' {
  const debug: DebugHub;
  export default debug;
}

declare module 'temtie/builder/dom.js' {
  export const DOMBuilder: Builder<Node, DocumentFragment>;
  export const SVGBuilder: Builder<Node, DocumentFragment>;
}

declare module 'temtie/builder/markup.js' {
  export const MarkupBuilder: Builder<object, object>;
  // reads the committed tree into a markup string: every text node and
  // attribute value escapes on the way out
  export function serialize(node: object): string;
}
