import { type MdastImage, stringifyBlock } from "../../helpers.js";
import type { BlockCodec, ParseContext, PMNode } from "../../types.js";
import {
  type ImageHtmlAttributes,
  imageHtmlTag,
  imageWireAttributes,
  parseImageHtmlAst,
} from "./image-html.js";

export const imageCodec: BlockCodec<MdastImage> = {
  name: "image",

  serialize(node, ctx) {
    const image = imageWireAttributes(node, ctx);
    if (image.width !== null) return imageHtmlTag(image);

    return stringifyBlock(ctx, {
      type: "paragraph",
      children: [{ type: "image", url: image.url, alt: image.alt, title: image.title }],
    });
  },

  parse(ast, ctx) {
    if (ast.type === "image") {
      return imageNodeFromAttributes(ctx, {
        url: ast.url,
        alt: ast.alt ?? null,
        title: ast.title ?? null,
        width: null,
      });
    }
    const tag = parseImageHtmlAst(ast);
    return tag && imageNodeFromAttributes(ctx, tag);
  },
};

export function imageNodeFromAttributes(ctx: ParseContext, tag: ImageHtmlAttributes): PMNode {
  return ctx.schema.node("image", {
    src: tag.url,
    alt: tag.alt,
    title: tag.title,
    width: tag.width,
  });
}
