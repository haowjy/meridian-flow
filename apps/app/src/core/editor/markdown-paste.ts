/** Markdown paste helpers for conservative GFM table clipboard handling. */

import { mdxCodec } from "@meridian/markup";
import { Fragment, type Schema, Slice } from "@tiptap/pm/model";
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
  return (text, _context, _plain, view) => {
    if (!looksLikeMarkdownTable(text)) return fallbackToPlainPaste();

    try {
      const { blocks } = mdxCodec({ schema: schema ?? view.state.schema }).parse(text);
      return Slice.maxOpen(Fragment.fromArray(blocks));
    } catch {
      return fallbackToPlainPaste();
    }
  };
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
