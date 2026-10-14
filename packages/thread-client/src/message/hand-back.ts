/**
 * The composer content a hand-back returns, built in the package so the app and `./mf` agree.
 *
 * `composerDocFromHandedBack` is the inverse of `serializeMessageDoc` over every
 * `UserMessageBlock` shape: serializing its document again gives the blocks that were handed
 * back. `prependMessageDoc` puts that document above what the writer has typed.
 */
import type { UserMessageBlock } from "@meridian/contracts/protocol";
import type { HandBackResult } from "@meridian/contracts/threads";
import type {
  BuiltMessageDoc,
  MessageDoc,
  MessageInlineNode,
  MessageParagraphNode,
  MessageReference,
} from "./types";

/** The label of a `[label](destination)` spelling, undoing `formatMarkdownLink`'s escapes. */
function spelledLabel(text: string): string {
  if (!text.startsWith("[")) return text;
  let label = "";
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index] as string;
    if (character === "\\" && index + 1 < text.length) {
      index += 1;
      label += text[index];
    } else if (character === "]") return label;
    else label += character;
  }
  return text;
}

/** A name for an image whose reference chip the sender never had (only an API client sends one). */
function uriName(uri: string): string {
  const last = uri.split(/[?#]/)[0]?.split("/").filter(Boolean).at(-1);
  return last || uri;
}

/** One message's paragraphs: a newline in text starts a new paragraph. */
function paragraphsOf(blocks: readonly UserMessageBlock[]): MessageParagraphNode[] {
  const paragraphs: MessageInlineNode[][] = [[]];
  const inline = (node: MessageInlineNode) => paragraphs.at(-1)?.push(node);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as UserMessageBlock;
    if (block.type === "text") {
      block.text.split("\n").forEach((line, lineIndex) => {
        if (lineIndex) paragraphs.push([]);
        if (line) inline({ type: "text", text: line });
      });
    } else if (block.type === "skill") {
      inline({
        type: "composerSkill",
        attrs: { slug: block.slug, name: block.name, description: block.description },
      });
    } else if (block.type === "reference") {
      // The serializer makes an image block right after an image-capable chip, so the chip
      // makes it again on send: that block is consumed here.
      const next = blocks[index + 1];
      const hasImage =
        next?.type === "image" && next.documentId === block.documentId && next.uri === block.uri;
      if (hasImage) index += 1;
      inline(
        chip({ documentId: block.documentId, uri: block.uri }, spelledLabel(block.text), hasImage),
      );
    } else {
      inline(chip({ documentId: block.documentId, uri: block.uri }, uriName(block.uri), true));
    }
  }
  return paragraphs.map((content) =>
    content.length ? { type: "paragraph", content } : { type: "paragraph" },
  );
}

function chip(
  target: { documentId: MessageReference["documentId"]; uri: string },
  label: string,
  imageCapable: boolean,
): MessageInlineNode {
  // The upload was adopted at admission, so it is an ordinary document now.
  return {
    type: "composerReference",
    attrs: { reference: { ...target, label, imageCapable, upload: null } },
  };
}

/**
 * The messages in send order, one empty paragraph between each, as one editable composer
 * document: no card or block wraps it.
 */
export function composerDocFromHandedBack(
  handedBack: HandBackResult["handedBack"],
): BuiltMessageDoc {
  const content: MessageParagraphNode[] = [];
  handedBack.forEach((message, index) => {
    if (index) content.push({ type: "paragraph" });
    content.push(...paragraphsOf(message.blocks));
  });
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function hasContent(node: MessageDoc): boolean {
  if (node.type === "text") return !!node.text;
  if (
    node.type === "composerSkill" ||
    node.type === "composerReference" ||
    node.type === "hardBreak"
  )
    return true;
  return (node.content ?? []).some(hasContent);
}

/**
 * The returned document above what is typed, with one empty paragraph between, keeping every
 * typed node. A composer with nothing typed gives just the returned document.
 */
export function prependMessageDoc(returned: MessageDoc, current: MessageDoc | null): MessageDoc {
  const above = returned.content ?? [];
  if (!current || !hasContent(current)) return { type: "doc", content: above };
  return { type: "doc", content: [...above, { type: "paragraph" }, ...(current.content ?? [])] };
}
