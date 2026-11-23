/* ꙋ temtie · types.d.ts */

declare module 'temtie' {
  export type PropertyKeyLike = string | number | symbol;

  /* Builder contract */
  export interface Builder<Node = unknown, Root = Node> {
    compile(strings: TemplateStringsArray): Template<Builder<Node, Root>>;
    createRoot(): Root;
    createMarker(): Node;
    parent(node: Node): Node | Root | null;
    prev(node: Node): Node | null;
    /**
     * Adopt the node or all fragment children after `after`; null appends.
     * A throw must leave source ownership and destination contents unchanged.
     */
    insert(parent: Node | Root, content: Node | Root, after?: Node | null): void;
    extract(start: Node, end: Node): Node | Root;
    remove(start: Node, end: Node): void;
    setChild(anchor: Node, value: Renderable): void;
    setProp(node: Node, name: PropertyKeyLike, value: unknown, source?: string): void;
    unsetProp(node: Node, name: PropertyKeyLike): void;
  }

  /* Template builder */
  export interface TemplateBuilder<Node = unknown, Root = Node>
    extends Pick<Builder<Node, Root>, 'createRoot' | 'createMarker' | 'setProp' | 'insert'> {
    createElement(tag: string, parent?: Node | Root): Node;
    createText(text: string, source?: string): Node;
    firstChild(container: Node | Root): Node | null;
    lastChild(container: Node | Root): Node | null;
    clone(root: Root): Root;
    resolve(root: Root, path: readonly number[]): Node;
    decodeStatic?(value: string, context?: 'text' | 'attr'): string;
    isVoidElement?(tag: string): boolean;
  }

  export type Builders = object;
  export type BuilderKeys<Bs extends Builders> = {
    [Name in keyof Bs]: Bs[Name] extends Builder<any, any> ? Name : never;
  }[keyof Bs];
  export type AnyBuilderOf<Bs extends Builders> = Extract<Bs[BuilderKeys<Bs>], Builder<any, any>>;
  export type BuilderNode<B> =
    B extends Builder<infer Node, any> ? Node :
    B extends TemplateBuilder<infer Node, any> ? Node :
    unknown;
  export type BuilderRoot<B> = B extends { createRoot(): infer Root } ? Root : unknown;
  export type RenderContainer<Bs extends Builders> =
    BuilderNode<AnyBuilderOf<Bs>> | BuilderRoot<AnyBuilderOf<Bs>>;

  export interface TemplateInstance<Node = unknown, Root = Node> {
    readonly content: Node | Root;
    readonly start: Node;
    readonly end: Node;
    readonly nodes: readonly Node[];
  }

  export interface Template<B = Builder> {
    readonly site: TemplateStringsArray;
    readonly builder: B;
    readonly holes: readonly Hole[];
    readonly keySlot: number;
    instantiate(): TemplateInstance<BuilderNode<B>, BuilderRoot<B>>;
  }

  export type Hole =
    | { readonly type: 'child'; readonly slot: number }
    | { readonly type: 'attr'; readonly slot: number; readonly prop: PropertyKeyLike }
    | { readonly type: 'spread'; readonly slot: number }
    | { readonly type: 'meta'; readonly slot: number; readonly name: PropertyKeyLike };

  /* Core runtime */
  export type Renderable =
    | string
    | number
    | boolean
    | null
    | undefined
    | object;

  export interface HoleRange<B extends Builder<any, any> = Builder<any, any>> {
    readonly start: BuilderNode<B>;
    readonly end: BuilderNode<B>;
    readonly builder: B;
    clear(): void;
  }

  export interface Handle<B extends Builder<any, any> = Builder<any, any>, Bs extends Builders = DefaultBuilders> {
    readonly kind: 'child' | 'attr' | 'meta';
    readonly builder: B;
    readonly node: BuilderNode<B> | null;
    readonly marker: BuilderNode<B> | null;
    readonly prop: PropertyKeyLike | null;
    readonly name: PropertyKeyLike | null;
    readonly target: Instance<Bs>;
    set?(value: Renderable): void;
    range?(): HoleRange<B> | null;
  }

  export type StageFn<V = any, Bs extends Builders = DefaultBuilders> = (
    target: Instance<Bs>,
    prev: V | undefined,
    next: V
  ) => void;

  export interface ValueDescriptor<
    V = any,
    B extends Builder<any, any> = Builder<any, any>,
    Bs extends Builders = DefaultBuilders
  > {
    stage?: StageFn<V, Bs>;
    commit?(handle: Handle<B, Bs>, prev: V | undefined, next: V): void;
    release?(handle: Handle<B, Bs>, current: V): void;
  }

  export type Channel = (strings: TemplateStringsArray, ...values: Renderable[]) => void;

  export interface DefaultBuilders {
    html: Builder<Node, DocumentFragment>;
    svg: Builder<Node, DocumentFragment>;
  }

  export type Instance<Bs extends Builders = DefaultBuilders> = {
    readonly [Name in BuilderKeys<Bs>]: Channel;
  };

  export type Mount = <Bs extends Builders = DefaultBuilders>(
    container: RenderContainer<Bs>,
    builders: Bs
  ) => Instance<Bs>;
  export type Capture = <Bs extends Builders = DefaultBuilders>() => Instance<Bs>;
  export type Commit = (instance: Instance<any>) => void;
  export type Discard = (instance: Instance<any>) => void;
  export type Reset = (instance: Instance<any>) => void;
  export type Amend = (instance: Instance<any>) => void;

  /* Debug */
  export interface DebugTarget {
    readonly parent: DebugTarget | null;
    readonly children: ReadonlySet<DebugTarget>;
  }

  export type DebugVia = 'render' | 'discard' | 'reset' | 'amend';

  export type DebugOccupant =
    | { readonly kind: 'plain' }
    | { readonly kind: 'body'; readonly body: DebugTarget }
    | { readonly kind: 'instance'; readonly body: DebugTarget | null; readonly spec: object | Function };

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
  }

  interface DebugEventBase {
    readonly seq: number;
    readonly cause: number; // enclosing span seq, 0 at root
    readonly stack?: Error; // present on stage/commit while debug.stacks is on
  }

  export type DebugEvent = DebugEventBase & (
    | { type: 'mount'; target: DebugTarget; container: unknown; builders: readonly string[] }
    | { type: 'call'; target: DebugTarget; pass: number; via: DebugVia }
    | { type: 'stage'; target: DebugTarget; pass: number; segment: DebugSegment; template: Template; fresh: boolean; key?: unknown }
    | { type: 'claim' | 'end'; binding: DebugBinding; occupant: DebugOccupant | null }
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
    enabled: boolean;
    stacks: boolean;
    cause: number;
    on(listener: (event: DebugEvent) => void): () => void;
    disable(): void; // irreversible for this module instance
    emit<E extends { type: string }>(event: E): E & { seq: number; cause: number };
    assert(condition: unknown, message: string, event?: Record<string, unknown>): void;
    meter(spans: Record<string, readonly [start: string, end: string]>, perf?: DebugMeterClock): () => void;
  }
  export {}; // keep unexported helper types private
}

declare module 'temtie/core.js' {
  import type { Mount, Capture, Commit, Discard, Reset, Amend } from 'temtie';

  export const mount: Mount;
  export const capture: Capture;
  export const commit: Commit;
  export const discard: Discard;
  export const reset: Reset;
  export const amend: Amend;
  export const TEMPLATE_HOLE_TYPES: {
    readonly CHILD: 'child';
    readonly ATTR: 'attr';
    readonly SPREAD: 'spread';
    readonly META: 'meta';
  };
}

declare module 'temtie/parser.js' {
  import type { TemplateBuilder, Template } from 'temtie';

  export function compileTemplate<B extends TemplateBuilder<any, any>>(
    strings: TemplateStringsArray,
    builder: B
  ): Template<B>;
  export const TEMPLATE_HOLE_TYPES: {
    readonly CHILD: 'child';
    readonly ATTR: 'attr';
    readonly SPREAD: 'spread';
    readonly META: 'meta';
  };
}

declare module 'temtie/debug.js' {
  import type { DebugHub } from 'temtie';

  const debug: DebugHub;
  export default debug;
}

declare module 'temtie/builder/dom.js' {
  import type { Builder, TemplateBuilder } from 'temtie';

  export class DOMBuilder {
    static voidElements: Set<string>;
    static namespace: string | null;
    static TemplateBuilder: new (owner: DOMBuilder) => TemplateBuilder<Node, DocumentFragment>;
    constructor(document?: Document, options?: { namespace?: string | null });
    readonly document: Document;
    readonly namespace: string | null;
  }
  export interface DOMBuilder extends Builder<Node, DocumentFragment>, TemplateBuilder<Node, DocumentFragment> {}

  export class SVGBuilder extends DOMBuilder {}

  export const dom: DOMBuilder;
  export const svg: SVGBuilder;
}

declare module 'temtie/builder/markup.js' {
  import type { Builder, TemplateBuilder } from 'temtie';

  export class MarkupBuilder {
    static voidElements: Set<string>;
    serialize(node: object): string;
  }
  export interface MarkupBuilder extends Builder<object, object>, TemplateBuilder<object, object> {}

  export const markup: MarkupBuilder;
  export function serialize(node: object): string;
}
