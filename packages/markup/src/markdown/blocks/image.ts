import { type MdastImage, type MdastWikiLinkImage, stringifyBlock } from "../../helpers.js";
import type { BlockCodec } from "../../types.js";
import { wikilinkTarget } from "../wikilink-target.js";

export const imageCodec: BlockCodec<MdastImage | MdastWikiLinkImage> = {
  name: "image",

  serialize(node, ctx) {
    const src = String(node.attrs.src ?? "");
    const assetId = src.startsWith("asset:") ? src.slice("asset:".length) : null;
    const url = assetId ? ctx.assetPathResolver.pathForAsset(assetId) : src;
    const target = wikilinkTarget(url);
    return stringifyBlock(ctx, {
      type: "paragraph",
      children: [
        target === null
          ? {
              type: "image",
              url,
              alt: node.attrs.alt ?? null,
              title: node.attrs.title ?? null,
            }
          : {
              type: "wikiLinkImage",
              target,
              alt: node.attrs.alt ?? null,
              title: node.attrs.title ?? null,
            },
      ],
    });
  },

  parse(ast, ctx) {
    if (ast.type !== "image" && ast.type !== "wikiLinkImage") return null;
    if (ast.type === "wikiLinkImage") {
      return ctx.schema.node("image", {
        src: `[[${ast.target}]]`,
        alt: ast.alt ?? null,
        title: ast.title ?? null,
      });
    }
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
