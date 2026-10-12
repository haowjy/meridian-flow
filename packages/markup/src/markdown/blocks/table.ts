/** Liberal GFM-table ingress and the canonical HTML table serializer. */

import {
  type MdastInline,
  type MdastTable,
  type MdastTableCell,
  parseInlineChildren,
} from "../../helpers.js";
import type { BlockCodec } from "../../types.js";
import { GFM_INGRESS_HARD_BREAK } from "../table-ingress.js";
import { parseHtmlTable, serializeHtmlTable } from "./table-html.js";

export const tableCodec: BlockCodec<MdastTable> = {
  name: "table",

  serialize(node, ctx) {
    return serializeHtmlTable(node, ctx);
  },

  parse(ast, ctx) {
    if (ast.type !== "table") return parseHtmlTable(ast, ctx);
    if (ast.children.length === 0) return null;

    const align = ast.align ?? [];
    return ctx.schema.node(
      "table",
      null,
      ast.children.map((row, rowIndex) =>
        ctx.schema.node(
          "table_row",
          null,
          row.children.map((cell, colIndex) =>
            ctx.schema.node(
              rowIndex === 0 ? "table_header" : "table_cell",
              { alignment: align[colIndex] ?? null },
              [
                ctx.schema.node(
                  "paragraph",
                  null,
                  parseInlineChildren(hardBreaksFromGfm(cell.children), ctx),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  },
};

function hardBreaksFromGfm(children: MdastTableCell["children"]): MdastTableCell["children"] {
  return replaceHardBreaks(children, (node) => {
    if (node.type === "html" && node.value === GFM_INGRESS_HARD_BREAK) return { type: "break" };
    if (node.type === "mdxJsxTextElement") {
      const jsx = node as {
        name: string | null;
        children: MdastInline[];
        attributes: Array<{ type: string; name?: string; value?: unknown }>;
      };
      if (jsx.name === "br" && jsx.children.length === 0 && jsx.attributes.length === 0) {
        return { type: "break" };
      }
    }
    return node;
  });
}

function replaceHardBreaks(
  children: MdastTableCell["children"],
  replace: (node: MdastInline) => MdastInline,
): MdastTableCell["children"] {
  return children.map((child) => {
    const replaced = replace(child);
    if (!("children" in replaced) || !Array.isArray(replaced.children)) return replaced;
    return {
      ...replaced,
      children: replaceHardBreaks(replaced.children as MdastInline[], replace),
    } as MdastInline;
  });
}
