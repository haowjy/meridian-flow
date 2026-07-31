/** Liberal GFM-table ingress and the canonical HTML table serializer. */

import {
  type MdastInline,
  type MdastTable,
  type MdastTableCell,
  parseInlineChildren,
} from "../../helpers.js";
import type { BlockCodec } from "../../types.js";
import {
  closesFence,
  isContainerBlockPrefix,
  openingFenceAt,
  stripIndentedQuotePrefix,
} from "../container.js";
import { parseHtmlTable, serializeHtmlTable } from "./table-html.js";

const GFM_INGRESS_HARD_BREAK = "<br/>";

/**
 * Remark cannot recognize a pipe-table row continued by a Markdown hard break.
 * Fold that ingress-only spelling before parsing; serialization never emits it.
 */
export function normalizeGfmTableHardBreaks(source: string): string {
  const lines = source.split("\n");
  const out: string[] = [];
  let index = 0;
  let fence: { marker: string; length: number } | null = null;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (fence) {
      out.push(line);
      if (closesFence(lines, index, fence)) fence = null;
      index++;
      continue;
    }

    const openingFence = openingFenceAt(lines, index);
    if (openingFence) {
      fence = openingFence;
      out.push(line);
      index++;
      continue;
    }

    const header = pipeRowAt(lines, index);
    const delimiter = header ? pipeRowAt(lines, header.end + 1) : null;
    if (!header || !delimiter || !isDelimiterRow(delimiter.value)) {
      out.push(line);
      index++;
      continue;
    }

    out.push(header.value, delimiter.value);
    index = delimiter.end + 1;
    while (index < lines.length) {
      const row = pipeRowAt(lines, index);
      if (!row || isDelimiterRow(row.value)) break;
      out.push(row.value);
      index = row.end + 1;
    }
  }

  return out.join("\n");
}

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

function pipeRowAt(lines: readonly string[], start: number): { value: string; end: number } | null {
  const first = lines[start];
  const prefix = first === undefined ? null : tableLinePrefix(lines, start);
  if (first === undefined || prefix === null) return null;

  let value = first;
  let end = start;
  while (hasOddTrailingBackslash(value)) {
    const continuation = lines[end + 1];
    const continuedPrefix = continuationPrefix(prefix);
    if (continuation === undefined || !continuation.startsWith(continuedPrefix)) return null;
    value = `${value.slice(0, -1)}${GFM_INGRESS_HARD_BREAK}${continuation.slice(continuedPrefix.length)}`;
    end++;
  }
  return value.trimEnd().endsWith("|") ? { value, end } : null;
}

function hasOddTrailingBackslash(value: string): boolean {
  const match = value.match(/\\+$/);
  return match !== null && match[0].length % 2 === 1;
}

function isDelimiterRow(value: string): boolean {
  const cells = value
    .slice(value.indexOf("|"))
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|");
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

function continuationPrefix(prefix: string): string {
  return prefix.replace(/(^|> )([-+*] |\d+[.)] )$/, (_match, container: string, marker: string) => {
    return `${container}${" ".repeat(marker.length)}`;
  });
}

function tableLinePrefix(lines: readonly string[], index: number): string | null {
  const line = lines[index];
  if (line === undefined) return null;
  const pipe = line.indexOf("|");
  if (pipe === -1) return null;
  const prefix = line.slice(0, pipe);
  const { remainder } = stripIndentedQuotePrefix(lines, index, prefix);
  return isContainerBlockPrefix(lines, index, remainder) ? prefix : null;
}
