/**
 * Doc → wire, at the one moment the composer stops being structural.
 *
 * The text half is unchanged by the TipTap migration: `onSubmit` carries a
 * plain string, and everything downstream — the append route, the
 * transcript's reference rendering — reads the same spellings the textarea
 * used to splice. So text serializes verbatim, a hard break is the newline
 * Shift+Enter always meant, paragraphs join on newlines, and a reference
 * token contributes exactly the `spelling` its pick computed.
 *
 * The image half is derived, never stored: an asset token IS the attachment
 * (token presence is the one truth), so at submit the same walk that spelled
 * the text also names the pictures, as `{ documentId, uri }` blocks the
 * server resolves to image data. The server checks that every image URI also
 * appears in the text — structurally guaranteed here, because the token's
 * spelling IS its URI.
 */

import type { UserMessageBlock } from "@meridian/contracts/threads";
import type { Fragment, Node as PMNode } from "@tiptap/pm/model";

import {
  composerReferenceTokens,
  REFERENCE_TOKEN_NODE,
  type ReferenceTokenAttributes,
} from "./reference-token";

/** The hard-break node keeps the manuscript's name (`MeridianHardBreak`). */
const HARD_BREAK_NODE = "hard_break";

function leafText(node: PMNode): string {
  if (node.type.name === HARD_BREAK_NODE) return "\n";
  if (node.type.name === REFERENCE_TOKEN_NODE) return String(node.attrs.spelling ?? "");
  return "";
}

/** The whole message, as `onSubmit` sends it (untrimmed — the caller trims). */
export function serializeComposerText(doc: PMNode): string {
  return serializeComposerFragment(doc.content);
}

/** Any slice of the message — what a copy puts on the clipboard as plain text. */
export function serializeComposerFragment(fragment: Fragment): string {
  return fragment.textBetween(0, fragment.size, "\n", leafText);
}

/** An image block: what an asset token becomes beside the message text. */
export type ComposerImageBlock = Extract<UserMessageBlock, { type: "image" }>;

/**
 * The pictures this draft is sending, one block per distinct asset — naming
 * the same picture twice is one attachment, so repeats collapse on identity.
 *
 * Two token families ride: `@`-picked pictures, and pasted image uploads once
 * their upload has resolved (a pending upload has no documentId yet, and
 * submit waits for it; a non-image upload is designation-only and never
 * becomes a block). Only the URI families the append contract accepts ride
 * along (`manuscript://assets/…`, `uploads://…`); any other token stays what
 * its spelling already is, text.
 */
export function composerImageBlocks(doc: PMNode): ComposerImageBlock[] {
  const blocks = new Map<string, ComposerImageBlock>();
  for (const token of composerReferenceTokens(doc)) {
    if (!ridesAsImageBlock(token)) continue;
    blocks.set(`${token.documentId}\0${token.uri}`, {
      type: "image",
      documentId: token.documentId,
      uri: token.uri,
    });
  }
  return [...blocks.values()];
}

function ridesAsImageBlock(token: ReferenceTokenAttributes): boolean {
  if (!imageBlockUri(token.uri)) return false;
  if (token.kind === "asset") return true;
  return (
    token.kind === "upload" &&
    token.upload?.state === "ready" &&
    token.upload.mimeType.startsWith("image/") &&
    token.documentId !== ""
  );
}

function imageBlockUri(uri: string): boolean {
  return uri.startsWith("manuscript://assets/") || uri.startsWith("uploads://");
}
