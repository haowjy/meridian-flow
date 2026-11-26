import { markdownCodec, mdxCodec, type SerializedBlock } from "@meridian/markup";
import { isBodyText } from "@meridian/prosemirror-schema";
import {
  Fragment,
  type Node as PMNode,
  type ResolvedPos,
  type Schema,
  Slice,
} from "@tiptap/pm/model";
import type { EditorProps } from "@tiptap/pm/view";

import type { PluggableList } from "unified";

import { clipboardLinkScope } from "./links";

export function markdownPasteAddsStructure(blocks: readonly PMNode[]): boolean {
  return blocks.some((block) => !isBodyText(block) || carriesInlineStructure(block));
}

export function markdownClipboardParser(
  schema?: Schema,
  remarkPlugins: () => PluggableList = () => [],
): NonNullable<EditorProps["clipboardTextParser"]> {
  return (text, $context, plain, view) => {
    if (plain) return defaultPlainTextPaste();

    let blocks: readonly PMNode[];
    try {
      blocks = markdownCodec({
        schema: schema ?? view.state.schema,
        remarkPlugins: remarkPlugins(),
      }).parse(text).blocks;
    } catch {
      return defaultPlainTextPaste();
    }

    const meaningful = blocks.filter(isMeaningfulBlock);
    if (!markdownPasteAddsStructure(meaningful)) return defaultPlainTextPaste();

    const only = meaningful.length === 1 ? meaningful[0] : undefined;
    if (only && isBodyText(only)) return new Slice(Fragment.from(only), 1, 1);

    if (!canHostBlocks($context)) return defaultPlainTextPaste();

    return new Slice(Fragment.fromArray([...meaningful]), 0, 0);
  };
}

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
  return !(isBodyText(block) && block.childCount === 0);
}

function canHostBlocks($context: ResolvedPos): boolean {
  for (let depth = $context.depth; depth >= 0; depth -= 1) {
    if ($context.node(depth).type.spec.code) return false;
  }
  return true;
}

function defaultPlainTextPaste(): Slice {
  // ProseMirror treats undefined as “use the default plain-text parser”, but
  // its TypeScript signature only permits Slice. Keep the runtime contract.
  return undefined as unknown as Slice;
}

export const markdownClipboardSerializer: NonNullable<EditorProps["clipboardTextSerializer"]> = (
  copied,
  view,
) => {
  const schema = view.state.schema;
  let content = copied.content;
  if (content.firstChild?.type.spec.tableRole === "row") {
    content = Fragment.from(schema.nodes.table.create(null, content));
  }
  const blocks: PMNode[] = [];
  if (content.firstChild?.isInline) {
    blocks.push(schema.nodes.paragraph.create(null, content));
  } else {
    content.forEach((node) => {
      blocks.push(node);
    });
  }
  const links = clipboardLinkScope(view.state);
  const markdown = markdownCodec({ schema });
  // A figure or a component has no Markdown form, and a copy that throws
  // here loses the whole clipboard, the HTML a rich paste reads included.
  let entries: SerializedBlock[];
  try {
    entries = markdown.serializeBlocks(blocks, links);
  } catch {
    entries = mdxCodec({ schema }).serializeBlocks(blocks, links);
  }
  return entries.map((entry) => entry.gap + entry.body).join("");
};
