import { type MdastImage, stringifyBlock } from "../../helpers.js";
import type { BlockCodec } from "../../types.js";

export const imageCodec: BlockCodec<MdastImage> = {
  name: "image",

  serialize(node, ctx) {
    return stringifyBlock(ctx, {
      type: "paragraph",
      children: [
        {
          type: "image",
          url: String(node.attrs.src ?? ""),
          alt: node.attrs.alt ?? null,
          title: node.attrs.title ?? null,
        },
      ],
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "image") return null;
    return ctx.schema.node("image", {
      src: ast.url ?? "",
      alt: ast.alt ?? null,
      title: ast.title ?? null,
    });
  },
};
