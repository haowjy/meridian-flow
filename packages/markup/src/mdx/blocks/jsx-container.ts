import type { ComponentRegistry } from "../../components.js";
import {
  invalidJsxFallback,
  isMdxJsxFlowElement,
  jsxAttributesFromProps,
  type MdastJsxFlow,
  parseBlockChildren,
  parseComponentProps,
  pmBlockChildrenToMdast,
  registeredComponent,
  stringifyBlock,
} from "../../helpers.js";
import type { BlockCodec } from "../../types.js";
import { propsRecord } from "./props.js";

export function createJsxContainerCodec(components?: ComponentRegistry): BlockCodec<MdastJsxFlow> {
  return {
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
      const spec = registeredComponent(components, ast.name);
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
}
