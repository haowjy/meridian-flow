/**
 * The markdown door for clipboard text.
 *
 * Everything in a Meridian document is markdown, so text arriving on the
 * clipboard is read as the document it describes rather than the characters it
 * contains: a writer, or the AI relay they are working with, who pastes
 * headings, lists, fences, tables and links gets headings, lists, fences,
 * tables and links. `@meridian/markup`'s `markdownCodec` is the same GFM parser
 * the wire uses, wikilinks included, so nothing here has to know what markdown
 * looks like.
 *
 * `markdownCodec` and not `mdxCodec`: the clipboard carries text from anywhere,
 * and MDX reads `<` and `{` as syntax. Fiction contains both.
 *
 * The door only opens when it has something to offer. ProseMirror's own
 * plain-text paste already produces paragraphs of literal text, so a parse that
 * amounts to those same paragraphs is declined and the default runs instead:
 * ordinary pasted prose never takes a detour through a parser that could
 * re-spell it. `markdownPasteAddsStructure` is that decision, made on the
 * parsed blocks rather than on a guess about the raw text.
 */

import {
  type AssetPathResolver,
  markdownCodec,
  unresolvedAssetPathResolver,
} from "@meridian/markup";
import {
  Fragment,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
  Slice,
} from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";

/**
 * Does this parse carry anything plain-text paste would have thrown away?
 *
 * Anything that is not a bare paragraph does: headings, lists, quotes, fences,
 * tables, dividers. So does a paragraph holding a mark or a non-text inline
 * node, because a link, an emphasis or an image is the structure those literal
 * characters were spelling.
 *
 * What deliberately does not: paragraphs of plain text, however many. That is
 * the false-positive guard. A soft-wrapped line, a `#` inside a sentence, an
 * asterisk used as punctuation — each parses to plain paragraphs, so the codec
 * and the default paste agree and the default wins.
 */
export function markdownPasteAddsStructure(blocks: readonly PMNode[]): boolean {
  return blocks.some((block) => block.type.name !== "paragraph" || carriesInlineStructure(block));
}

export function markdownClipboardParser(
  schema?: Schema,
  assetPathResolver: AssetPathResolver = unresolvedAssetPathResolver,
): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, plain, view) => {
    // Paste-without-formatting asked for the characters, and gets them.
    if (plain) return defaultPlainTextPaste();

    let blocks: readonly PMNode[];
    try {
      blocks = markdownCodec({
        assetPathResolver,
        schema: schema ?? view.state.schema,
      }).parse(text).blocks;
    } catch {
      return defaultPlainTextPaste();
    }

    const meaningful = blocks.filter(isMeaningfulBlock);
    if (!markdownPasteAddsStructure(meaningful)) return defaultPlainTextPaste();

    // One paragraph is inline content wherever the caret is: a bolded phrase
    // pasted mid-sentence must join the sentence, not break it in two.
    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    if (only?.type.name === "paragraph") return new Slice(Fragment.from(only), 1, 1);

    if (!canHostBlocks($context)) return defaultPlainTextPaste();

    return new Slice(Fragment.fromArray([...meaningful]), 0, 0);
  };
}

/** A link, an emphasis, an image: structure the literal characters spelled. */
function carriesInlineStructure(block: PMNode): boolean {
  let found = false;
  block.descendants((node) => {
    if (found) return false;
    if (!node.isText || node.marks.length > 0) found = true;
    return !found;
  });
  return found;
}

function isMeaningfulBlock(block: PMNode): boolean {
  return !(block.type.name === "paragraph" && block.childCount === 0);
}

// Block structure cannot live inside a code block or a table cell, so a paste
// landing in one declines and lets ProseMirror's default plain-text handling
// run: inserting a closed block slice there splits the surrounding node.
// ProseMirror already keeps clipboard text literal inside a code block, but the
// rule is ours, so it is stated here rather than inherited. Pristine
// literal-text paste inside a cell is a separate stock-editor concern tracked
// under #92.
function canHostBlocks($context: ResolvedPos): boolean {
  for (let depth = $context.depth; depth >= 0; depth -= 1) {
    const spec = $context.node(depth).type.spec;
    if (spec.code || spec.tableRole) return false;
  }
  return true;
}

function defaultPlainTextPaste(): Slice {
  // ProseMirror treats undefined as “use the default plain-text parser”, but
  // its TypeScript signature only permits Slice. Keep the runtime contract.
  return undefined as unknown as Slice;
}
