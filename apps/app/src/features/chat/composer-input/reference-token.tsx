/**
 * The reference token: what a composer `@` pick leaves in the message.
 *
 * An inline atom, deliberately. The ruled physics — backspace on a reference
 * detaches it, a later chip's × removes it, hand-typed text never attaches —
 * is only honest when the reference is one indivisible object the caret can
 * never enter (divergence record: composer-tiptap-atomic-tokens.md). So a pick
 * inserts this node rather than splicing text, and the node carries everything
 * the message will ever need to say about it: the identity a chip row can
 * subscribe to, and the `spelling` serialization writes to the wire.
 *
 * **`spelling` is computed at pick time, not at send time.** The catalog knows
 * whether a title is ambiguous only while the menu is open; a token that
 * waited until submit to decide between `[[Title]]` and the canonical URI
 * would be asking a catalog that may have moved.
 *
 * `kind` says what the token names — a page or a picture — and stays an
 * attribute rather than a fact so the attachment slices can add upload kinds
 * to the same node. An asset token is also where a message's image blocks
 * come from: at submit the composer walks these tokens and sends
 * `{ documentId, uri }` beside the text, so the model can see the picture the
 * sentence names.
 */

import { mergeAttributes, Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type NodeViewProps, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import { File, FileText, Image } from "lucide-react";

import { cn } from "@/lib/utils";

export const REFERENCE_TOKEN_NODE = "referenceToken";

/**
 * Paste-time upload lifecycle, carried on the token because the token IS the
 * attachment: the chip row derives every state it shows from these fields,
 * never from a parallel store. `state` walks uploading → ready (or failed);
 * the identity (`id`) is draft-local, minted at paste time, and is what the
 * lifecycle engine keys retries and detach-deletes on — `documentId` does not
 * exist until the server answers.
 */
export type ReferenceTokenUpload = {
  /** Draft-local attachment id (client-minted at paste time). */
  id: string;
  state: "uploading" | "ready" | "failed";
  /** The pasted file's MIME type; `image/*` is what earns a thumbnail. */
  mimeType: string;
  /** Object URL of the pasted bytes, the thumbnail while (and after) upload. */
  previewUrl: string;
  sizeBytes: number;
};

export type ReferenceTokenAttributes = {
  /** What the token names: a page, an asset file, or a pasted upload. */
  kind: "document" | "asset" | "upload";
  documentId: string;
  /**
   * The asset's catalog file type, null on the other kinds. `"image"` is
   * what earns an image block at submit; a PDF beside it is
   * designation-only — the pick spells its URI and rides as text alone.
   * (An upload's image-ness lives in `upload.mimeType` instead.)
   */
  fileType: string | null;
  /** The resolver's canonical spelling, kept for chips and future detach UI. */
  uri: string;
  /** What the pill shows: the document's title. */
  label: string;
  /** Exactly what serialization writes: `[[Title]]`, or the URI when ambiguous. */
  spelling: string;
  /** Present exactly when `kind` is `"upload"`. */
  upload: ReferenceTokenUpload | null;
};

export const ReferenceTokenNode = Node.create({
  name: REFERENCE_TOKEN_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "document" },
      documentId: { default: "" },
      fileType: { default: null },
      uri: { default: "" },
      label: { default: "" },
      spelling: { default: "" },
      upload: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-reference-token]",
        // Upload lifecycle state never revives from markup — a token pasted
        // back arrives as plain text anyway (clipboard speaks the wire).
        getAttrs: (element) => ({
          kind: element.getAttribute("data-kind") === "asset" ? "asset" : "document",
          documentId: element.getAttribute("data-document-id") ?? "",
          fileType: element.getAttribute("data-file-type"),
          uri: element.getAttribute("data-uri") ?? "",
          label: element.getAttribute("data-label") ?? "",
          spelling: element.getAttribute("data-spelling") ?? "",
          upload: null,
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as ReferenceTokenAttributes;
    return [
      "span",
      mergeAttributes({
        "data-reference-token": "",
        "data-kind": attrs.kind,
        "data-document-id": attrs.documentId,
        "data-file-type": attrs.fileType ?? undefined,
        "data-uri": attrs.uri,
        "data-label": attrs.label,
        "data-spelling": attrs.spelling,
      }),
      attrs.label,
    ];
  },

  /** What `getText` and a copied selection read for this leaf. */
  renderText({ node }) {
    return String(node.attrs.spelling ?? "");
  },

  addKeyboardShortcuts() {
    return {
      // Backspace at the token's boundary deletes the whole token — that IS
      // detach (the ruled physics). Whole, because the caret can never be
      // inside an atom, so there is no character of it to take first.
      Backspace: () => {
        const { empty, $from } = this.editor.state.selection;
        if (!empty) return false;
        const before = $from.nodeBefore;
        if (before?.type.name !== this.name) return false;
        return this.editor.commands.deleteRange({
          from: $from.pos - before.nodeSize,
          to: $from.pos,
        });
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ReferenceTokenView, { contentDOMElementTag: "span" });
  },
});

/**
 * The quiet inline pill. It sits in the sentence at the sentence's size, says
 * the document's name, and claims no color the prose around it does not have —
 * a token is a fact about the message, not a control demanding attention.
 * Selection (click, or shift-arrow onto it) is the one loud state, because a
 * selected token is one keystroke from gone.
 */
function ReferenceTokenView({ node, selected }: NodeViewProps) {
  const attrs = node.attrs as ReferenceTokenAttributes;
  // The icon says what the token holds, same glyphs as the menu rows: pixels
  // get the picture, a page the page, and a non-image asset the plain file it
  // is. A pasted upload reads off its MIME type, an asset off its catalog
  // file type.
  const pictorial =
    (attrs.kind === "asset" && attrs.fileType === "image") ||
    (attrs.kind === "upload" && (attrs.upload?.mimeType.startsWith("image/") ?? false));
  const Icon = pictorial ? Image : attrs.kind === "document" ? FileText : File;
  return (
    <NodeViewWrapper
      as="span"
      data-reference-token={attrs.kind}
      className={cn(
        "inline-flex max-w-full items-baseline gap-1 rounded-sm border border-border-subtle bg-muted/60 px-1 align-baseline",
        selected && "border-border-focus bg-accent text-accent-foreground",
      )}
    >
      <Icon aria-hidden className="size-[0.85em] shrink-0 self-center text-muted-foreground" />
      <span className="truncate">{attrs.label}</span>
    </NodeViewWrapper>
  );
}

/**
 * The tokens a draft is carrying, in document order — the seam the attachments
 * slices subscribe a chip row to. Presence in the doc is the one source of
 * attachment truth: deleting a token detaches, and nothing else needs to know.
 */
export function composerReferenceTokens(doc: PMNode): ReferenceTokenAttributes[] {
  const tokens: ReferenceTokenAttributes[] = [];
  doc.descendants((node) => {
    if (node.type.name === REFERENCE_TOKEN_NODE) {
      tokens.push(node.attrs as ReferenceTokenAttributes);
    }
    return true;
  });
  return tokens;
}
