/**
 * A picture on the wire, in its two spellings.
 *
 * Plain `![alt](src)` is the whole story for a picture at its natural size,
 * which is nearly all of them. A picture the writer resized carries a width
 * Markdown has nowhere to put, so it escalates to the raw `<img>` tag in
 * [`image-html.ts`](./image-html.ts) — the same ladder a table climbs when
 * pipes cannot hold its spans. Clearing the size walks back down, and the
 * result is byte-identical to what the picture spelled before it was touched.
 */

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

/**
 * The node a wire spelling means. Parse is pure syntax: the source stays as
 * written, and the host's binding pass claims a known picture as its
 * `asset:` ref (agent-edit `bindSources`).
 */
export function imageNodeFromAttributes(ctx: ParseContext, tag: ImageHtmlAttributes): PMNode {
  return ctx.schema.node("image", {
    src: tag.url,
    alt: tag.alt,
    title: tag.title,
    width: tag.width,
  });
}
