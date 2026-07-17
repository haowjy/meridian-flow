import { type MdastImage, stringifyBlock } from "../../helpers.js";
import type { BlockCodec } from "../../types.js";

export const imageCodec: BlockCodec<MdastImage> = {
  name: "image",

  serialize(node, ctx) {
    const src = String(node.attrs.src ?? "");
    const assetId = src.startsWith("asset:") ? src.slice("asset:".length) : null;
    return stringifyBlock(ctx, {
      type: "paragraph",
      children: [
        {
          type: "image",
          url: assetId ? ctx.assetPathResolver.pathForAsset(assetId) : src,
          alt: node.attrs.alt ?? null,
          title: node.attrs.title ?? null,
        },
      ],
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "image") return null;
    return ctx.schema.node("image", {
      src: ast.url ? assetRefForPath(ast.url, ctx.assetPathResolver.assetForPath(ast.url)) : "",
      alt: ast.alt ?? null,
      title: ast.title ?? null,
    });
  },
};

function assetRefForPath(path: string, assetDocumentId: string | null): string {
  return assetDocumentId ? `asset:${assetDocumentId}` : path;
}
