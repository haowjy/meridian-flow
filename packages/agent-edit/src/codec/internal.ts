import type { Mark, Node as PMNode, Schema } from "prosemirror-model";

import type { ComponentRegistry, ComponentSpec, PropSpec } from "../registry/component-registry.js";
import type { BlockCodec, MarkCodec, ParseContext, SerializeContext } from "./types.js";

export const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

/** Frozen remark-stringify options — the codec-wide determinism contract. */
export const MARKDOWN_STRINGIFY_OPTIONS = {
  bullet: "-",
  bulletOther: "*",
  emphasis: "*",
  strong: "*",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  rule: "-",
  ruleRepetition: 3,
  ruleSpaces: false,
  incrementListMarker: true,
  resourceLink: false,
  setext: false,
  tightDefinitions: true,
} as const;

export type MdastRoot = { type: "root"; children: MdastBlock[] };
export type MdastBlock =
  | MdastParagraph
  | MdastHeading
  | MdastBlockquote
  | MdastCode
  | MdastList
  | MdastListItem
  | MdastThematicBreak
  | MdastJsxFlow
  | MdastUnknown;
export type MdastInline =
  | MdastText
  | MdastStrong
  | MdastEmphasis
  | MdastInlineCode
  | MdastLink
  | MdastBreak
  | MdastImage
  | MdastJsxText
  | MdastUnknown;

export interface MdastText {
  type: "text";
  value: string;
}

export interface MdastStrong {
  type: "strong";
  children: MdastInline[];
}

export interface MdastEmphasis {
  type: "emphasis";
  children: MdastInline[];
}

export interface MdastInlineCode {
  type: "inlineCode";
  value: string;
}

export interface MdastLink {
  type: "link";
  url: string;
  title: string | null;
  children: MdastInline[];
}

export interface MdastBreak {
  type: "break";
}

export interface MdastImage {
  type: "image";
  url: string;
  alt: string | null;
  title: string | null;
}

export interface MdastParagraph {
  type: "paragraph";
  children: MdastInline[];
}

export interface MdastHeading {
  type: "heading";
  depth: number;
  children: MdastInline[];
}

export interface MdastBlockquote {
  type: "blockquote";
  children: MdastBlock[];
}

export interface MdastCode {
  type: "code";
  lang: string | null;
  value: string;
}

export interface MdastList {
  type: "list";
  ordered: boolean;
  start?: number;
  spread: boolean;
  children: MdastListItem[];
}

export interface MdastListItem {
  type: "listItem";
  spread: boolean;
  children: MdastBlock[];
}

export interface MdastThematicBreak {
  type: "thematicBreak";
}

export interface MdxJsxAttributeValueExpression {
  type: "mdxJsxAttributeValueExpression";
  value: string;
  data?: { estree?: unknown };
}

export type MdxJsxAttribute =
  | { type: "mdxJsxAttribute"; name: string; value: string | null | MdxJsxAttributeValueExpression }
  | { type: "mdxJsxExpressionAttribute"; value?: string }
  | { type: "mdxJsxSpreadAttribute"; value?: string };

export interface MdastJsxFlow {
  type: "mdxJsxFlowElement";
  name: string | null;
  attributes: MdxJsxAttribute[];
  children: MdastBlock[];
}

export interface MdastJsxText {
  type: "mdxJsxTextElement";
  name: string | null;
  attributes: MdxJsxAttribute[];
  children: MdastInline[];
}

export interface MdastUnknown {
  type: string;
  value?: string;
  children?: unknown[];
  position?: SourcePosition;
  [key: string]: unknown;
}

interface SourcePosition {
  start?: { offset?: number };
  end?: { offset?: number };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CodecRuntime {
  source: string;
  schema: Schema;
  components?: ComponentRegistry;
  blocks: readonly BlockCodec[];
  blockMap: ReadonlyMap<string, BlockCodec>;
  markMap: ReadonlyMap<string, MarkCodec>;
  parseMarkdown(content: string): MdastRoot;
  stringifyMarkdown(root: MdastRoot): string;
  mdx: boolean;
}

const runtimeKey: unique symbol = Symbol("agent-edit-codec-runtime");

type RuntimeContext = (SerializeContext | ParseContext) & { [runtimeKey]?: CodecRuntime };

export function withRuntime<T extends SerializeContext | ParseContext>(
  ctx: T,
  runtime: CodecRuntime,
): T {
  (ctx as RuntimeContext)[runtimeKey] = runtime;
  return ctx;
}

export function getRuntime(ctx: SerializeContext | ParseContext): CodecRuntime {
  const runtime = (ctx as RuntimeContext)[runtimeKey];
  if (!runtime) {
    throw new Error("codec runtime missing from context");
  }
  return runtime;
}

export function stringifyBlock(ctx: SerializeContext, block: MdastBlock): string {
  return getRuntime(ctx).stringifyMarkdown({ type: "root", children: [block] });
}

export function pmBlockChildrenToMdast(node: PMNode, ctx: SerializeContext): MdastBlock[] {
  const runtime = getRuntime(ctx);
  const out: MdastBlock[] = [];
  node.forEach((child) => {
    const codec = runtime.blockMap.get(child.type.name);
    if (!codec) {
      throw new Error(`pm->mdast: unsupported block node "${child.type.name}"`);
    }
    const serialized = codec.serialize(child, ctx);
    out.push(...demoteAutolinks(runtime.parseMarkdown(serialized)).children);
  });
  return out;
}

export function parseBlockChildren(children: readonly MdastBlock[], ctx: ParseContext): PMNode[] {
  const out = children
    .map((child) => parseBlockAst(child, ctx))
    .filter((node): node is PMNode => node !== null);
  return out.length > 0 ? out : [ctx.schema.node("paragraph")];
}

export function parseBlockAst(ast: unknown, ctx: ParseContext): PMNode | null {
  const runtime = getRuntime(ctx);
  for (const codec of runtime.blocks) {
    const parsed = codec.parse(ast, ctx);
    if (parsed) return parsed;
  }
  return rawTextParagraph(rawTextForAst(ast, ctx), ctx);
}

export function inlineContentToMdast(node: PMNode, ctx: SerializeContext): MdastInline[] {
  const out: MdastInline[] = [];
  node.forEach((child) => {
    switch (child.type.name) {
      case "text":
        out.push(markedTextToMdast(child.text ?? "", child.marks, ctx));
        break;
      case "hard_break":
        out.push({ type: "break" });
        break;
      case "image":
        ensureBlockCodecRegistered("image", ctx);
        out.push({
          type: "image",
          url: String(child.attrs.src ?? ""),
          alt: attrStringOrNull(child.attrs.alt),
          title: attrStringOrNull(child.attrs.title),
        });
        break;
      default:
        throw new Error(`pm->mdast: unsupported inline node "${child.type.name}"`);
    }
  });
  return out;
}

export function parseInlineChildren(
  children: readonly MdastInline[],
  ctx: ParseContext,
  activeMarks: readonly Mark[] = [],
): PMNode[] {
  const out: PMNode[] = [];
  for (const child of children) {
    switch (child.type) {
      case "text": {
        const value = typeof child.value === "string" ? child.value : "";
        if (value.length > 0) out.push(ctx.schema.text(value, activeMarks));
        break;
      }
      case "strong":
        out.push(
          ...parseInlineChildren(
            inlineChildrenOf(child),
            ctx,
            addMark(activeMarks, "strong", child, ctx),
          ),
        );
        break;
      case "emphasis":
        out.push(
          ...parseInlineChildren(
            inlineChildrenOf(child),
            ctx,
            addMark(activeMarks, "em", child, ctx),
          ),
        );
        break;
      case "inlineCode": {
        const value = typeof child.value === "string" ? child.value : "";
        if (value.length === 0) break;
        out.push(ctx.schema.text(value, addMark(activeMarks, "code", child, ctx)));
        break;
      }
      case "link":
        out.push(
          ...parseInlineChildren(
            inlineChildrenOf(child),
            ctx,
            addMark(activeMarks, "link", child, ctx),
          ),
        );
        break;
      case "break":
        out.push(ctx.schema.node("hard_break"));
        break;
      case "image": {
        const imageCodec = getRuntime(ctx).blockMap.get("image");
        if (!imageCodec) throw new Error('mdast->pm: missing "image" codec');
        const image = imageCodec.parse(child, ctx);
        if (image) out.push(image);
        break;
      }
      case "mdxJsxTextElement": {
        const raw = rawTextForAst(child, ctx);
        if (raw.length > 0) out.push(ctx.schema.text(raw, activeMarks));
        break;
      }
      default: {
        const raw = rawTextForAst(child, ctx);
        if (raw.length > 0) out.push(ctx.schema.text(raw, activeMarks));
        break;
      }
    }
  }
  return out;
}

export function isWhitespaceOnlyText(value: string): boolean {
  return value.length > 0 && /^\s+$/.test(value);
}

export function isWhitespaceOnlyParagraph(node: PMNode): boolean {
  if (node.childCount === 0) return true;
  return isWhitespaceOnlyText(node.textContent);
}

export function isSentinelParagraph(node: MdastParagraph): boolean {
  if (node.children.length === 0) return true;
  if (node.children.length !== 1) return false;
  const only = node.children[0];
  return (
    only.type === "text" &&
    typeof only.value === "string" &&
    (only.value === EMPTY_PARAGRAPH_SENTINEL || isWhitespaceOnlyText(only.value))
  );
}

export function rawTextParagraph(text: string, ctx: ParseContext): PMNode | null {
  if (text.length === 0) return ctx.schema.node("paragraph");
  return ctx.schema.node("paragraph", null, [ctx.schema.text(text)]);
}

export function rawTextForAst(ast: unknown, ctx: ParseContext): string {
  const runtime = getRuntime(ctx);
  const position = asRecord(ast)?.position;
  const start = asRecord(asRecord(position)?.start)?.offset;
  const end = asRecord(asRecord(position)?.end)?.offset;
  if (typeof start === "number" && typeof end === "number") {
    return runtime.source.slice(start, end);
  }
  const value = asRecord(ast)?.value;
  if (typeof value === "string") return value;
  return "";
}

export function isMdxJsxFlowElement(ast: unknown): ast is MdastJsxFlow {
  return asRecord(ast)?.type === "mdxJsxFlowElement";
}

export function isMdxJsxTextElement(ast: unknown): ast is MdastJsxText {
  return asRecord(ast)?.type === "mdxJsxTextElement";
}

export function isParagraph(ast: unknown): ast is MdastParagraph {
  return asRecord(ast)?.type === "paragraph" && Array.isArray(asRecord(ast)?.children);
}

export function singleTextJsxChild(ast: unknown): MdastJsxText | null {
  if (!isParagraph(ast) || ast.children.length !== 1) return null;
  const only = ast.children[0];
  return isMdxJsxTextElement(only) ? only : null;
}

export function jsxAttributesFromProps(props: Record<string, unknown>): MdxJsxAttribute[] {
  return Object.keys(props)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => jsxAttribute(name, props[name]));
}

export function jsxAttribute(name: string, value: unknown): MdxJsxAttribute {
  if (typeof value === "string") return { type: "mdxJsxAttribute", name, value };
  if (!isJsonValue(value)) {
    throw new Error(`JSX prop "${name}" is not JSON-serializable`);
  }
  return {
    type: "mdxJsxAttribute",
    name,
    value: { type: "mdxJsxAttributeValueExpression", value: JSON.stringify(value) },
  };
}

export function parseComponentProps(
  componentName: string,
  attributes: readonly MdxJsxAttribute[] | undefined,
  spec?: ComponentSpec,
): { ok: true; props: Record<string, JsonValue> } | { ok: false; reason: string } {
  const props: Record<string, JsonValue> = {};
  for (const attr of attributes ?? []) {
    if (attr.type === "mdxJsxExpressionAttribute" || attr.type === "mdxJsxSpreadAttribute") {
      return { ok: false, reason: `${componentName}: spread/expression attrs forbidden` };
    }
    if (attr.value === null) {
      return {
        ok: false,
        reason: `${componentName}: boolean/shorthand attribute "${attr.name}" forbidden`,
      };
    }
    const value = parseAttributeValue(attr.value);
    if (!value.ok) return { ok: false, reason: `${componentName}.${attr.name}: ${value.reason}` };
    props[attr.name] = value.value;
  }

  if (!spec) return { ok: true, props };

  for (const propName of Object.keys(props)) {
    if (!Object.hasOwn(spec.props, propName)) {
      return { ok: false, reason: `${componentName}: unknown prop "${propName}"` };
    }
  }

  for (const [propName, propSpec] of Object.entries(spec.props)) {
    if (!Object.hasOwn(props, propName)) {
      if (propSpec.required)
        return { ok: false, reason: `${componentName}: missing prop "${propName}"` };
      if (Object.hasOwn(propSpec, "default")) {
        if (!isJsonValue(propSpec.default)) {
          return {
            ok: false,
            reason: `${componentName}.${propName}: default is not JSON-serializable`,
          };
        }
        props[propName] = propSpec.default;
      }
      continue;
    }
    if (!propMatchesSpec(props[propName], propSpec)) {
      return { ok: false, reason: `${componentName}.${propName}: expected ${propSpec.type}` };
    }
  }

  return { ok: true, props };
}

export function registeredComponent(
  components: ComponentRegistry | undefined,
  name: string | null,
): ComponentSpec | null {
  if (!name || name === "Figure") return null;
  return components?.[name] ?? null;
}

export function invalidJsxFallback(ast: unknown, ctx: ParseContext): PMNode | null {
  return rawTextParagraph(rawTextForAst(ast, ctx), ctx);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value))
    return Number.isFinite(value as number) || typeof value !== "number";
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
}

export function escapeProseForMdxIngress(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCodeFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    if (inCodeFence) {
      out.push(line);
      if (line.trimStart().startsWith(fenceMarker)) {
        inCodeFence = false;
        fenceMarker = "";
      }
      continue;
    }

    const fence = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      inCodeFence = true;
      fenceMarker = fence[1];
      out.push(line);
      continue;
    }

    out.push(escapeProseSegment(line));
  }
  return out.join("\n");
}

export function demoteAutolinks(tree: MdastRoot): MdastRoot {
  visitChildren(tree, (node, idx, parent) => {
    const record = asRecord(node);
    if (record?.type !== "link" || idx === null || !parent) return;
    const children = record.children;
    const url = record.url;
    const title = record.title;
    if (!Array.isArray(children) || typeof url !== "string" || title) return;
    const first = children[0];
    const firstRecord = asRecord(first);
    if (children.length === 1 && firstRecord?.type === "text" && firstRecord.value === url) {
      parent.children[idx] = { type: "text", value: url };
    }
  });
  return tree;
}

function inlineChildrenOf(node: MdastInline): MdastInline[] {
  const children = asRecord(node)?.children;
  return Array.isArray(children) ? (children as MdastInline[]) : [];
}

function markedTextToMdast(
  text: string,
  marks: readonly Mark[],
  ctx: SerializeContext,
): MdastInline {
  let node: MdastInline = { type: "text", value: text };
  const order = ["code", "em", "strong", "link"];
  const sorted = [...marks].sort((a, b) => order.indexOf(a.type.name) - order.indexOf(b.type.name));
  for (const mark of sorted) {
    ensureMarkCodecRegistered(mark.type.name, ctx);
    switch (mark.type.name) {
      case "strong":
        node = { type: "strong", children: [node] };
        break;
      case "em":
        node = { type: "emphasis", children: [node] };
        break;
      case "code":
        node = { type: "inlineCode", value: text };
        break;
      case "link":
        node = {
          type: "link",
          url: String(mark.attrs.href ?? ""),
          title: attrStringOrNull(mark.attrs.title),
          children: [node],
        };
        break;
      default:
        throw new Error(`pm->mdast: unsupported mark "${mark.type.name}"`);
    }
  }
  return node;
}

function addMark(
  activeMarks: readonly Mark[],
  name: "strong" | "em" | "code" | "link",
  ast: unknown,
  ctx: ParseContext,
): readonly Mark[] {
  const runtime = getRuntime(ctx);
  const codec = runtime.markMap.get(name);
  if (!codec) throw new Error(`mdast->pm: missing mark codec "${name}"`);
  const attrs = codec.parse(ast, ctx);
  if (attrs === null) throw new Error(`mdast->pm: mark codec "${name}" rejected matching AST`);
  const markType = ctx.schema.marks[name];
  if (!markType) throw new Error(`schema missing mark "${name}"`);
  return markType.create(attrs).addToSet([...activeMarks]);
}

function ensureMarkCodecRegistered(name: string, ctx: SerializeContext): void {
  if (!getRuntime(ctx).markMap.has(name)) {
    throw new Error(`pm->mdast: missing mark codec "${name}"`);
  }
}

function ensureBlockCodecRegistered(name: string, ctx: SerializeContext): void {
  if (!getRuntime(ctx).blockMap.has(name)) {
    throw new Error(`pm->mdast: missing block codec "${name}"`);
  }
}

function attrStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseAttributeValue(
  value: string | MdxJsxAttributeValueExpression,
): { ok: true; value: JsonValue } | { ok: false; reason: string } {
  if (typeof value === "string") return { ok: true, value };
  const estreeValue = value.data?.estree ? jsonFromEstree(value.data.estree) : undefined;
  if (estreeValue !== undefined) return { ok: true, value: estreeValue };
  try {
    const parsed = JSON.parse(value.value) as unknown;
    if (!isJsonValue(parsed)) return { ok: false, reason: "expression is not JSON-serializable" };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, reason: "expression is not a JSON literal" };
  }
}

function jsonFromEstree(program: unknown): JsonValue | undefined {
  const body = asRecord(program)?.body;
  if (!Array.isArray(body) || body.length !== 1) return undefined;
  const statement = asRecord(body[0]);
  if (statement?.type !== "ExpressionStatement") return undefined;
  return jsonFromExpression(statement.expression);
}

function jsonFromExpression(expression: unknown): JsonValue | undefined {
  const node = asRecord(expression);
  if (!node) return undefined;
  switch (node.type) {
    case "Literal":
      return isJsonValue(node.value) ? node.value : undefined;
    case "UnaryExpression": {
      const operator = node.operator;
      const argument = jsonFromExpression(node.argument);
      if (typeof argument !== "number") return undefined;
      if (operator === "-") return -argument;
      if (operator === "+") return argument;
      return undefined;
    }
    case "ArrayExpression": {
      const elements = node.elements;
      if (!Array.isArray(elements)) return undefined;
      const out: JsonValue[] = [];
      for (const element of elements) {
        if (element === null) return undefined;
        const parsed = jsonFromExpression(element);
        if (parsed === undefined) return undefined;
        out.push(parsed);
      }
      return out;
    }
    case "ObjectExpression": {
      const properties = node.properties;
      if (!Array.isArray(properties)) return undefined;
      const out: Record<string, JsonValue> = {};
      for (const property of properties) {
        const prop = asRecord(property);
        if (prop?.type !== "Property" || prop.kind !== "init" || prop.method === true) {
          return undefined;
        }
        const key = propertyKey(prop.key, prop.computed === true);
        if (key === null) return undefined;
        const parsed = jsonFromExpression(prop.value);
        if (parsed === undefined) return undefined;
        out[key] = parsed;
      }
      return out;
    }
    case "TemplateLiteral": {
      const expressions = node.expressions;
      const quasis = node.quasis;
      if (
        !Array.isArray(expressions) ||
        expressions.length > 0 ||
        !Array.isArray(quasis) ||
        quasis.length !== 1
      ) {
        return undefined;
      }
      const cooked = asRecord(asRecord(quasis[0])?.value)?.cooked;
      return typeof cooked === "string" ? cooked : undefined;
    }
    default:
      return undefined;
  }
}

function propertyKey(key: unknown, computed: boolean): string | null {
  const record = asRecord(key);
  if (!record) return null;
  if (record.type === "Identifier" && !computed && typeof record.name === "string")
    return record.name;
  if (
    record.type === "Literal" &&
    (typeof record.value === "string" || typeof record.value === "number")
  ) {
    return String(record.value);
  }
  return null;
}

function propMatchesSpec(value: JsonValue, spec: PropSpec): boolean {
  switch (spec.type) {
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
    default:
      return typeof value === spec.type;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function visitChildren(
  node: { children?: unknown[] },
  visitor: (node: unknown, index: number | null, parent: { children: unknown[] } | null) => void,
): void {
  const stack: Array<{
    node: unknown;
    index: number | null;
    parent: { children: unknown[] } | null;
  }> = [{ node, index: null, parent: null }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    visitor(current.node, current.index, current.parent);
    const children = asRecord(current.node)?.children;
    if (!Array.isArray(children)) continue;
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ node: children[index], index, parent: { children } });
    }
  }
}

function isPascalCaseComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function skipBalanced(text: string, start: number, open: string, close: string): number | null {
  if (text[start] !== open) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    if (text[i] === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function tryConsumeJsxTag(text: string, start: number): number | null {
  if (text[start] !== "<") return null;
  let i = start + 1;
  const closing = text[i] === "/";
  if (closing) i++;

  const nameStart = i;
  if (!/[A-Z]/.test(text[i] ?? "")) return null;
  while (i < text.length && /[A-Za-z0-9]/.test(text[i] ?? "")) i++;
  const name = text.slice(nameStart, i);
  if (!isPascalCaseComponentName(name)) return null;

  if (closing) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    return text[i] === ">" ? i + 1 - start : null;
  }

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (i >= text.length) return null;

    if (text[i] === "/") return text[i + 1] === ">" ? i + 2 - start : null;
    if (text[i] === ">") return i + 1 - start;

    if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
      continue;
    }

    const attrStart = i;
    while (i < text.length && /[A-Za-z0-9:_-]/.test(text[i] ?? "")) i++;
    if (i === attrStart) return null;

    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text[i] !== "=") continue;
    i++;
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;

    const quote = text[i];
    if (quote === '"' || quote === "'") {
      i++;
      while (i < text.length && text[i] !== quote) i++;
      if (i >= text.length) return null;
      i++;
    } else if (text[i] === "{") {
      const end = skipBalanced(text, i, "{", "}");
      if (end === null) return null;
      i = end;
    } else {
      while (i < text.length && !/[\s/>]/.test(text[i] ?? "")) i++;
    }
  }
  return null;
}

function tryConsumeInlineCodeSpan(text: string, start: number): number | null {
  if (text[start] !== "`") return null;

  let openLen = 0;
  while (start + openLen < text.length && text[start + openLen] === "`") openLen++;

  let i = start + openLen;
  while (i < text.length) {
    if (text[i] === "`") {
      let closeLen = 0;
      while (i + closeLen < text.length && text[i + closeLen] === "`") closeLen++;
      if (closeLen === openLen) return i + openLen - start;
      i += closeLen;
      continue;
    }
    i++;
  }
  return null;
}

function escapeProseSegment(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === "\\" && i + 1 < segment.length) {
      out += segment[i] + segment[i + 1];
      i += 2;
      continue;
    }
    if (segment[i] === "`") {
      const len = tryConsumeInlineCodeSpan(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
    }
    if (segment[i] === "<") {
      const len = tryConsumeJsxTag(segment, i);
      if (len !== null) {
        out += segment.slice(i, i + len);
        i += len;
        continue;
      }
      out += "\\<";
      i++;
      continue;
    }
    if (segment[i] === "{") {
      out += "\\{";
      i++;
      continue;
    }
    out += segment[i];
    i++;
  }
  return out;
}
