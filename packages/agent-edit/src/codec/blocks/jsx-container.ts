import {
  invalidJsxFallback,
  isJsonValue,
  isMdxJsxFlowElement,
  type JsonValue,
  jsxAttributesFromProps,
  type MdastJsxFlow,
  parseBlockChildren,
  parseComponentProps,
  pmBlockChildrenToMdast,
  registeredComponent,
  stringifyBlock,
} from "../internal.js";
import type { BlockCodec } from "../types.js";

export const jsxContainerCodec: BlockCodec<MdastJsxFlow> = {
  name: "jsx_container",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "mdxJsxFlowElement",
      name: String(node.attrs.name ?? ""),
      attributes: jsxAttributesFromProps(propsRecord(node.attrs.props)),
      children: pmBlockChildrenToMdast(node, ctx),
    });
  },

  parse(ast, ctx) {
    if (!isMdxJsxFlowElement(ast) || ast.name === "Figure") return null;
    const spec = registeredComponent(ctx.components, ast.name);
    if (!spec) return invalidJsxFallback(ast, ctx);
    if (spec.kind !== "container" || spec.children !== "block") return null;
    if (ast.children.length === 0) return invalidJsxFallback(ast, ctx);

    const parsedProps = parseComponentProps(spec.name, ast.attributes, spec);
    if (!parsedProps.ok) return invalidJsxFallback(ast, ctx);

    return ctx.schema.node(
      "jsx_container",
      { name: spec.name, props: parsedProps.props },
      parseBlockChildren(ast.children, ctx),
    );
  },
};

function propsRecord(value: unknown): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const entries: Record<string, JsonValue> = {};
  for (const [key, prop] of Object.entries(value)) {
    if (!isJsonValue(prop)) throw new Error(`JSX prop "${key}" is not JSON-serializable`);
    entries[key] = prop;
  }
  return entries;
}
