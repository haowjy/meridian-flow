/**
 * Qualifies a bare `uploads://name` in model-written Markdown to the writing thread's top chat.
 *
 * A bare uploads address is contextual: it means "this chat's file" only while read from that
 * chat. A document stores a contextual href as written, so a manuscript or KB page that embeds
 * one would later name whichever chat reads it. The write door has the chat, so it spells the
 * address in full before the text is bound.
 */
import type { WriteToolInput } from "@meridian/agent-edit/integration";

const BARE_UPLOADS = /(?<![\w+.-])uploads:\/\/(?!@)/g;

export function qualifyBareUploads(markdown: string, chatRef: string): string {
  return markdown.replace(BARE_UPLOADS, `uploads://@/${chatRef}/`);
}

/** The write with its `content` qualified; unchanged when the thread has no chat handle. */
export function qualifyWriteUploads(input: WriteToolInput, chatRef: string | null | undefined) {
  if (!chatRef || !("content" in input) || typeof input.content !== "string") return input;
  return { ...input, content: qualifyBareUploads(input.content, chatRef) };
}
