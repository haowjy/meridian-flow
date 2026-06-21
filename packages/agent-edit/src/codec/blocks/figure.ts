import {
  invalidJsxFallback,
  isMdxJsxFlowElement,
  jsxAttribute,
  type MdastJsxFlow,
  type MdxJsxAttribute,
  parseComponentProps,
  stringifyBlock,
} from "../internal.js";
import type { BlockCodec } from "../types.js";

const FIGURE_ATTRS = new Set(["src", "alt", "label", "caption"]);

export const figureCodec: BlockCodec<MdastJsxFlow> = {
  name: "figure",

  serialize(node, ctx) {
    const attrs: MdxJsxAttribute[] = [];
    for (const key of ["src", "alt", "label", "caption"] as const) {
      const value = node.attrs[key];
      if (value !== null && value !== undefined) attrs.push(jsxAttribute(key, String(value)));
    }
    return stringifyBlock(ctx, {
      type: "mdxJsxFlowElement",
      name: "Figure",
      attributes: attrs,
      children: [],
    });
  },

  parse(ast, ctx) {
    if (!isMdxJsxFlowElement(ast) || ast.name !== "Figure") return null;
    if (ast.children.length > 0) return invalidJsxFallback(ast, ctx);
    const parsed = parseComponentProps("Figure", ast.attributes);
    if (!parsed.ok) return invalidJsxFallback(ast, ctx);
    for (const key of Object.keys(parsed.props)) {
      if (!FIGURE_ATTRS.has(key)) return invalidJsxFallback(ast, ctx);
      if (typeof parsed.props[key] !== "string") return invalidJsxFallback(ast, ctx);
    }
    return ctx.schema.node("figure", {
      src: parsed.props.src ?? "",
      alt: parsed.props.alt ?? null,
      label: parsed.props.label ?? null,
      caption: parsed.props.caption ?? "",
    });
  },
};
