/** Markdown paste helpers for conservative GFM table clipboard handling. */

import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import {
  Fragment,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
  Slice,
} from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";

const TABLE_DELIMITER_CELL = /^:?-{1,}:?$/;

export function looksLikeMarkdownTable(text: string): boolean {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      looksLikeTableHeader(lines[index] ?? "") &&
      looksLikeTableDelimiter(lines[index + 1] ?? "")
    ) {
      return true;
    }
  }

  return false;
}

export function markdownTableClipboardParser(
  schema?: Schema,
): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, plain, view) => {
    if (plain) return fallbackToPlainPaste();
    if (!canHostTable($context)) return fallbackToPlainPaste();
    if (!looksLikeMarkdownTable(text)) return fallbackToPlainPaste();

    try {
      const { blocks } = mdxCodec({
        assetPathResolver: unresolvedAssetPathResolver,
        schema: schema ?? view.state.schema,
      }).parse(text);
      const meaningfulBlocks = blocks.filter(isMeaningfulBlock);
      if (
        meaningfulBlocks.length === 0 ||
        !meaningfulBlocks.every((block) => block.type.name === "table")
      ) {
        return fallbackToPlainPaste();
      }

      return new Slice(Fragment.fromArray(meaningfulBlocks), 0, 0);
    } catch {
      return fallbackToPlainPaste();
    }
  };
}

function isMeaningfulBlock(block: PMNode): boolean {
  return !(block.type.name === "paragraph" && block.childCount === 0);
}

// A top-level table can't live inside a code block or another table, so paste
// destinations inside those must decline — otherwise inserting a closed table
// slice splits the surrounding table / code block. Declining hands off to
// ProseMirror's default plain-text paste (same as if this feature were absent);
// pristine literal-text paste inside a cell is a separate stock-editor concern
// tracked under #92.
function canHostTable($context: ResolvedPos): boolean {
  for (let depth = $context.depth; depth >= 0; depth -= 1) {
    const spec = $context.node(depth).type.spec;
    if (spec.code || spec.tableRole) return false;
  }
  return true;
}

function looksLikeTableHeader(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function looksLikeTableDelimiter(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = tableCells(line);
  return cells.length >= 2 && cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

function tableCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function fallbackToPlainPaste(): Slice {
  // ProseMirror treats undefined as “use the default plain-text parser”, but
  // its TypeScript signature only permits Slice. Keep the runtime contract.
  return undefined as unknown as Slice;
}
