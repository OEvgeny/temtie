/* ꙋ temtie · types.d.ts */

export type PropertyKeyLike = string | number | symbol;
declare const TEMTIE_VALUE: unique symbol;

/* ── Builder contract ── */
export interface Builder<Node = unknown, Root = Node> {
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
  setChild(startMarker: Node, endMarker: Node, value: Renderable): void;
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

export interface Template<B extends Builder = Builder, Metadata = unknown> {
  readonly site: TemplateStringsArray;
  readonly builder: B;
  readonly fragment: BuilderRoot<B>;
  readonly holes: readonly Hole[];
  readonly keySlot: number;
  readonly metadata: Metadata | null;
}

export type Hole =
  | { readonly type: 'child'; readonly slot: number; readonly startPath: readonly number[]; readonly endPath: readonly number[] }
  | { readonly type: 'attr'; readonly slot: number; readonly path: readonly number[]; readonly prop: PropertyKeyLike }
  | { readonly type: 'spread'; readonly slot: number; readonly path: readonly number[] }
  | { readonly type: 'meta'; readonly slot: number; readonly path: readonly number[]; readonly name: PropertyKeyLike };

/* ── View API ── */
export type Renderable =
  | string
  | number
  | boolean
  | null
  | undefined
  | SlotCall<any>
  | object
  | Iterable<Renderable>;

export interface ViewOptions<Bs extends Builders = DefaultBuilders> {
  id?: string | number;
  builders: Bs;
  scheduleUpdate?: (callback: () => void) => void;
}

export type TemplateTag<Bs extends Builders, Name extends BuilderKeys<Bs> = BuilderKeys<Bs>> =
  (strings: TemplateStringsArray, ...values: Renderable[]) => RootWithBuilders<Bs>;

export interface Root<Bs extends Builders = DefaultBuilders> {
  readonly node: RenderContainer<Bs> | null;
  next(callback: () => void): void;
}

export type SlotRender<Props extends readonly unknown[] = readonly unknown[]> =
  (...props: Props) => void | symbol;

export interface SlotCall<
  Props extends readonly unknown[] = readonly unknown[],
  Result = void | SlotRender<Props>
> {
  readonly [TEMTIE_VALUE]: unknown;
  (root: RootWithBuilders): Result;
}

export type SlotDefinition<
  Props extends readonly unknown[] = readonly [],
  Result = void | SlotRender<Props>
> = (...props: Props) => SlotCall<Props, Result>;

export interface Define {
  (
    render: (root: RootWithBuilders<DefaultBuilders>) => void
  ): SlotDefinition<readonly [], void>;
  <const Props extends readonly unknown[] = readonly []>(
    render: (root: RootWithBuilders<DefaultBuilders>, ...props: Props) => void
  ): SlotDefinition<Props, void>;
  state(
    init: (root: RootWithBuilders<DefaultBuilders>) => SlotRender<readonly []>
  ): SlotDefinition<readonly [], SlotRender<readonly []>>;
  state<const Props extends readonly unknown[] = readonly []>(
    init: (root: RootWithBuilders<DefaultBuilders>, ...initialProps: Props) => SlotRender<Props>
  ): SlotDefinition<Props, SlotRender<Props>>;
}

export const define: Define;
export type DefineFn = typeof define;

export type RootWithBuilders<Bs extends Builders = DefaultBuilders> =
  Root<Bs> & { [Name in BuilderKeys<Bs>]: TemplateTag<Bs, Name> };

export interface View<Bs extends Builders = DefaultBuilders> {
  mount(container: RenderContainer<Bs>, options: ViewOptions<Bs>): View<Bs>;
  render(): void;
  update(): void;
}

export function view<Bs extends Builders = DefaultBuilders>(
  render: (root: RootWithBuilders<Bs>) => void
): View<Bs>;

export function compileTemplate<B extends Builder>(
  strings: TemplateStringsArray,
  builder: B,
  options?: { vctx?: { id?: string | number } | null }
): Template<B>;

export function parseTemplate<B extends Builder>(
  strings: TemplateStringsArray,
  builder: B
): Pick<Template<B>, 'fragment' | 'holes'>;

export function clearTemplateCache(builder?: Builder | null): void;

/* ── Default builder set ── */
export interface DefaultBuilders {
  html: Builder<Node, DocumentFragment>;
  svg: Builder<Node, DocumentFragment>;
}

declare module 'temtie/builder/dom.js' {
  export const DOMBuilder: Builder<Node, DocumentFragment>;
  export const SVGBuilder: Builder<Node, DocumentFragment>;
}
