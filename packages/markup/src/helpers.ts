/** Shared helpers for block and mark codec authors. */

import type { Mark, Node as PMNode } from "prosemirror-model";

import type {
  JsonValue,
  MdastBlock,
  MdastBreak,
  MdastImage,
  MdastInline,
  MdastJsxFlow,
  MdastJsxText,
  MdastParagraph,
  MdastRoot,
  MdastText,
  MdxJsxAttribute,
  MdxJsxAttributeValueExpression,
} from "./ast.js";
import {
  builtInComponents,
  type ComponentRegistry,
  type ComponentSpec,
  type PropSpec,
} from "./components.js";
import { getRuntime } from "./runtime.js";
import type { ParseContext, SerializeContext } from "./types.js";

export type {
  JsonValue,
  MdastBlock,
  MdastBlockquote,
  MdastCode,
  MdastHeading,
  MdastImage,
  MdastInline,
  MdastJsxFlow,
  MdastJsxText,
  MdastList,
  MdastListItem,
  MdastParagraph,
  MdastRoot,
  MdastTable,
  MdastTableCell,
  MdastThematicBreak,
  MdxJsxAttribute,
} from "./ast.js";

export const EMPTY_PARAGRAPH_SENTINEL = "\u00a0";

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
  const tokens: InlineToken[] = [];
  node.forEach((child) => {
    switch (child.type.name) {
      case "text":
        tokens.push({ type: "text", value: child.text ?? "", marks: child.marks });
        break;
      case "hard_break":
        tokens.push({ type: "break", marks: child.marks });
        break;
      case "image":
        ensureBlockCodecRegistered("image", ctx);
        tokens.push({
          type: "image",
          url: String(child.attrs.src ?? ""),
          alt: attrStringOrNull(child.attrs.alt),
          title: attrStringOrNull(child.attrs.title),
          marks: child.marks,
        });
        break;
      default:
        throw new Error(`pm->mdast: unsupported inline node "${child.type.name}"`);
    }
  });
  return inlineTokensToMdast(tokens, ctx);
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
      default: {
        const marked = addRegisteredMark(activeMarks, child, ctx);
        if (marked) {
          const value = inlineCodeValue(child);
          if (value !== null) {
            if (value.length > 0) out.push(ctx.schema.text(value, marked));
          } else {
            out.push(...parseInlineChildren(inlineChildrenOf(child), ctx, marked));
          }
          break;
        }
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
  if (!name || Object.hasOwn(builtInComponents, name)) return null;
  return components?.[name] ?? null;
}

export function invalidJsxFallback(ast: unknown, ctx: ParseContext): PMNode | null {
  const raw = rawTextForAst(ast, ctx);
  if (/\n\s*\n/.test(raw)) {
    return ctx.schema.node(
      "code_block",
      { language: "mdx" },
      raw.length > 0 ? [ctx.schema.text(raw)] : [],
    );
  }
  return rawTextParagraph(raw, ctx);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (["string", "number", "boolean"].includes(typeof value))
    return Number.isFinite(value as number) || typeof value !== "number";
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isPlainObject(value)) return Object.values(value).every(isJsonValue);
  return false;
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

type InlineToken =
  | (MdastText & { marks: readonly Mark[] })
  | (MdastBreak & { marks: readonly Mark[] })
  | (MdastImage & { marks: readonly Mark[] });

function inlineTokensToMdast(tokens: readonly InlineToken[], ctx: SerializeContext): MdastInline[] {
  const out: MdastInline[] = [];

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index];
    const mark = firstMark(token.marks);
    if (!mark) {
      out.push(tokenToMdast(token));
      index++;
      continue;
    }

    const group: InlineToken[] = [];
    while (index < tokens.length && hasMark(tokens[index], mark)) {
      group.push(withoutMark(tokens[index], mark));
      index++;
    }

    const codec = getRuntime(ctx).markMap.get(mark.type.name);
    if (!codec) throw new Error(`pm->mdast: missing mark codec "${mark.type.name}"`);

    // Inline code protects literal text; other marks wrap already-serialized child syntax.
    const inner = mark.type.name === "code" ? plainText(group) : inlineMdastToMarkdown(group, ctx);
    out.push(...inlineMarkdownToMdast(codec.serialize(inner, mark.attrs, ctx), ctx));
  }

  return out;
}

function firstMark(marks: readonly Mark[]): Mark | null {
  return marks[0] ?? null;
}

function hasMark(token: InlineToken, mark: Mark): boolean {
  return token.marks.some((candidate) => candidate.eq(mark));
}

function withoutMark<T extends InlineToken>(token: T, mark: Mark): T {
  return { ...token, marks: token.marks.filter((candidate) => !candidate.eq(mark)) } as T;
}

function tokenToMdast(token: InlineToken): MdastInline {
  const { marks: _marks, ...ast } = token;
  return ast;
}

function inlineMdastToMarkdown(tokens: readonly InlineToken[], ctx: SerializeContext): string {
  return trimOneTrailingNewline(
    getRuntime(ctx).stringifyMarkdown({
      type: "root",
      children: [{ type: "paragraph", children: inlineTokensToMdast(tokens, ctx) }],
    }),
  );
}

function inlineMarkdownToMdast(markdown: string, ctx: SerializeContext): MdastInline[] {
  if (markdown.length === 0) return [];
  const root = getRuntime(ctx).parseMarkdown(markdown);
  const paragraph = root.children[0];
  if (root.children.length !== 1 || !isParagraph(paragraph)) {
    throw new Error(`mark codec produced non-inline markdown: ${markdown}`);
  }
  return paragraph.children;
}

function plainText(tokens: readonly InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case "text":
          return token.value;
        case "break":
          return "\n";
        case "image":
          return token.alt ?? "";
        default:
          return "";
      }
    })
    .join("");
}

function addRegisteredMark(
  activeMarks: readonly Mark[],
  ast: unknown,
  ctx: ParseContext,
): readonly Mark[] | null {
  const runtime = getRuntime(ctx);
  for (const codec of runtime.markMap.values()) {
    const attrs = codec.parse(ast, ctx);
    if (attrs === null) continue;
    const markType = ctx.schema.marks[codec.name];
    if (!markType) throw new Error(`schema missing mark "${codec.name}"`);
    return markType.create(attrs).addToSet([...activeMarks]);
  }
  return null;
}

function ensureBlockCodecRegistered(name: string, ctx: SerializeContext): void {
  if (!getRuntime(ctx).blockMap.has(name)) {
    throw new Error(`pm->mdast: missing block codec "${name}"`);
  }
}

function attrStringOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function inlineCodeValue(ast: unknown): string | null {
  const record = asRecord(ast);
  if (record?.type !== "inlineCode") return null;
  return typeof record.value === "string" ? record.value : "";
}

function trimOneTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
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
