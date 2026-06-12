// @ts-nocheck
/**
 * collapse-markdown-blocks — normalizes Streamdown's streaming block tokens so
 * live markdown renders with the same paragraph spacing as static mode (collapse
 * whitespace tokens, merge adjacent prose, keep fenced code/math separate).
 * Pure helper for the streaming `Markdown` path.
 */
import { parseMarkdownIntoBlocks } from "streamdown";

/** Fenced code, indented code, or display math — keep as separate streaming blocks. */
export function isFenceMarkdownBlock(block: string): boolean {
  const trimmed = block.trim();
  return /^```/.test(trimmed) || /^~~~/.test(trimmed) || /^\$\$/.test(trimmed);
}

/**
 * Streamdown streaming mode splits on marked lexer tokens, including blank lines.
 * Collapse whitespace-only tokens, normalize runs of newlines, and merge adjacent
 * prose blocks so paragraph gaps match static mode (one parse tree).
 */
export function collapseMarkdownBlocks(markdown: string): string[] {
  const normalized = markdown.replace(/\n{3,}/g, "\n\n");
  const raw = parseMarkdownIntoBlocks(normalized).filter((block) => block.trim().length > 0);

  const merged: string[] = [];
  for (const block of raw) {
    if (isFenceMarkdownBlock(block)) {
      merged.push(block);
      continue;
    }

    const last = merged.at(-1);
    if (last !== undefined && !isFenceMarkdownBlock(last)) {
      merged[merged.length - 1] = `${last}\n\n${block}`;
    } else {
      merged.push(block);
    }
  }

  return merged;
}
