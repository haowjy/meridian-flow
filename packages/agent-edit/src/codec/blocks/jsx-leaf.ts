import {
  inlineContentToMdast,
  invalidJsxFallback,
  isJsonValue,
  isMdxJsxFlowElement,
  isParagraph,
  type JsonValue,
  jsxAttributesFromProps,
  type MdastBlock,
  type MdastInline,
  type MdastJsxFlow,
  type MdastJsxText,
  type MdastParagraph,
  parseComponentProps,
  parseInlineChildren,
  registeredComponent,
  singleTextJsxChild,
  stringifyBlock,
} from "../internal.js";
import type { BlockCodec, ParseContext, PMNode } from "../types.js";

export const jsxLeafCodec: BlockCodec<MdastJsxFlow | MdastParagraph> = {
  name: "jsx_leaf",

  serialize(node, ctx) {
    const name = String(node.attrs.name ?? "");
    const props = propsRecord(node.attrs.props);
    const attributes = jsxAttributesFromProps(props);
    const children = inlineContentToMdast(node, ctx);
    if (children.length === 0) {
      return stringifyBlock(ctx, {
        type: "mdxJsxFlowElement",
        name,
        attributes,
        children: [],
      });
    }
    return stringifyBlock(ctx, {
      type: "paragraph",
      children: [
        {
          type: "mdxJsxTextElement",
          name,
          attributes,
          children,
        },
      ],
    });
  },

  parse(ast, ctx) {
    const jsx = leafCandidate(ast);
    if (!jsx) return null;
    const spec = registeredComponent(ctx.components, jsx.name);
    if (!spec) return invalidJsxFallback(ast, ctx);
    if (spec.kind !== "leaf" || spec.children === "block") return null;

    const parsedProps = parseComponentProps(spec.name, jsx.attributes, spec);
    if (!parsedProps.ok) return invalidJsxFallback(ast, ctx);

    const children = leafChildrenToPm(jsx, ctx);
    if (children === null) return invalidJsxFallback(ast, ctx);
    return ctx.schema.node("jsx_leaf", { name: spec.name, props: parsedProps.props }, children);
  },
};

function leafCandidate(ast: unknown): MdastJsxFlow | MdastJsxText | null {
  if (isMdxJsxFlowElement(ast)) return ast;
  return singleTextJsxChild(ast);
}

function leafChildrenToPm(jsx: MdastJsxFlow | MdastJsxText, ctx: ParseContext): PMNode[] | null {
  const inlineChildren = inlineChildrenForLeaf(jsx);
  if (inlineChildren === null) return null;
  const children = parseInlineChildren(inlineChildren, ctx);
  return children.every((child) => child.type.name === "text") ? children : null;
}

function inlineChildrenForLeaf(jsx: MdastJsxFlow | MdastJsxText): MdastInline[] | null {
  if (jsx.type === "mdxJsxTextElement") return jsx.children;
  if (jsx.children.length === 0) return [];
  if (jsx.children.length === 1) {
    const only = jsx.children[0] as MdastBlock;
    if (isParagraph(only)) return only.children;
  }
  return null;
}

function propsRecord(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries: Record<string, JsonValue> = {};
  for (const [key, prop] of Object.entries(value)) {
    if (!isJsonValue(prop)) throw new Error(`JSX prop "${key}" is not JSON-serializable`);
    entries[key] = prop;
  }
  return entries;
}
