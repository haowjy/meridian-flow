/**
 * What the editor knows about the link under a position, and what a form
 * commits back.
 *
 * Every link surface asks the same three things — what is here, where has that
 * range moved to since, and what should the commit do about it — so all three
 * answers live here and the surfaces stay presentation. Resolution by
 * selection serves Ctrl+K and the toolbar button; resolution by position
 * serves the right-click menu, which must act on the link the pointer hit
 * rather than on wherever the caret happened to be.
 */
import { type Editor, getMarkRange } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

import { anchorRange, type EditorAnchor, followAnchor, resolveAnchor } from "../anchors";
import { normalizeLinkHref } from "./link-target";

export type LinkSelection = {
  from: number;
  to: number;
  attributes: Record<string, unknown>;
  /**
   * The mark object itself. ProseMirror interns marks by attributes, so this
   * is the identity that survives a remap: the same link resolved before and
   * after an edit above it comes back as the same object.
   */
  identity: Mark;
};

/** The link mark touching the selection, whole, or null when there is none. */
export function linkAtSelection(editor: Editor): LinkSelection | null {
  const { selection } = editor.state;
  if (!editor.schema.marks.link) return null;
  if (!selection.empty && !editor.isActive("link")) return null;
  return linkAt(editor.state, selection.from);
}

/** The link mark covering `pos`, whole. What a right-click hit. */
export function linkAt(state: EditorState, pos: number): LinkSelection | null {
  const linkType = state.schema.marks.link;
  // Callers arrive with positions a Yjs relative position resolved to, which
  // can sit at the very end of the document, and with the character after
  // them. Resolving off the end throws inside a Yjs update handler, where the
  // throw is swallowed and the editor quietly stops applying peer writes.
  if (!linkType || pos < 0 || pos > state.doc.content.size) return null;
  const range = getMarkRange(state.doc.resolve(pos), linkType);
  if (!range) return null;

  const mark = state.doc
    .resolve(range.from)
    .nodeAfter?.marks.find((candidate) => candidate.type === linkType);
  return mark ? { from: range.from, to: range.to, attributes: mark.attrs, identity: mark } : null;
}

export function linkAttributesAtSelection(editor: Editor): Record<string, unknown> | null {
  return linkAtSelection(editor)?.attributes ?? null;
}

/** The href a resolved link carries, as a string a classifier can read. */
export function linkHref(link: LinkSelection): string {
  return String(link.attributes.href ?? "");
}

/**
 * A range that survives what ProseMirror's own mapping cannot — the shared
 * [`EditorAnchor`](../anchors.ts), under the name link surfaces know it by.
 */
export type LinkAnchor = EditorAnchor;

/** Pin a range so a surface can find it again after the document moves. */
export const anchorLinkRange = anchorRange;

/** Where that range sits now, or null when it is gone. */
export const resolveLinkAnchor = resolveAnchor;

export type LinkDraft = LinkAnchor & {
  /** Range the commit rewrites: the selection, or the whole existing link.
   *  Carried as a `LinkAnchor`, so it survives an AI write landing under it. */
  /** A link mark already covers the range; committing edits or removes it. */
  existing: boolean;
  /**
   * A bare caret has no text to link, so the form asks for it. A non-empty
   * selection already supplies the text and asks only for the URL (§5.5).
   */
  needsText: boolean;
  text: string;
  href: string;
};

export type LinkCommit = { text: string; href: string };

export type LinkCommitResult = "applied" | "removed" | "invalid" | "refused";

/** What the form should show for the current selection. */
export function resolveLinkDraft(editor: Editor): LinkDraft {
  const { empty, from, to } = editor.state.selection;
  const link = linkAtSelection(editor);
  if (!link) {
    return {
      ...anchorLinkRange(editor.state, { from, to }),
      existing: false,
      needsText: empty,
      text: "",
      href: "",
    };
  }

  return {
    ...anchorLinkRange(editor.state, { from: link.from, to: link.to }),
    existing: true,
    needsText: empty,
    text: editor.state.doc.textBetween(link.from, link.to),
    href: linkHref(link),
  };
}

/**
 * Where the draft's range sits after a document change, or null when the words
 * it was opened for are gone.
 *
 * A form is open for as long as the writer takes to type a URL, and the
 * document moves underneath it. Both edges bias away from the range: text
 * typed against either boundary belongs to the document, not to the phrase the
 * writer selected.
 */
export function mapLinkDraft(
  state: EditorState,
  draft: LinkDraft,
  mapping: Mappable,
): LinkDraft | null {
  const at = followAnchor(state, draft, mapping);
  return at ? { ...draft, ...at } : null;
}

/**
 * The same link after a document change, or null when the writer's link is
 * gone. What keeps a surface aimed at one link from acting on another.
 *
 * Coordinates outlive the thing that was at them. A peer deletes the link and
 * the words after it slide back into those numbers; a peer edits the href and
 * the same range now means a different destination. Both read as "still there"
 * to a position alone, so the mark decides: same attributes, same destination,
 * and anything else means this surface has nothing left to act on.
 */
export function relocateLink(
  state: EditorState,
  link: { anchor: LinkAnchor; identity: Mark },
  mapping: Mappable,
): LinkSelection | null {
  const at = resolveLinkAnchor(state, link.anchor, mapping);
  if (!at) return null;

  // One character in, and re-read whole: a writer typing inside a link grows
  // it, and the surface should follow the mark rather than the old edges.
  const current = linkAt(state, at.from + 1);
  return current?.identity.eq(link.identity) ? current : null;
}

/**
 * Enter commits; an emptied URL over an existing link removes it (§5.5).
 * Returns what happened so the form can stay open on an unusable URL instead
 * of closing over a change it never made.
 */
export function commitLinkDraft(
  editor: Editor,
  draft: LinkDraft,
  commit: LinkCommit,
): LinkCommitResult {
  if (editor.isDestroyed || !editor.isEditable) return "refused";

  const range = { from: draft.from, to: draft.to };
  const href = commit.href.trim();
  if (!href) {
    if (!draft.existing) return "invalid";
    const removed = editor.chain().focus().setTextSelection(range).unsetLink().run();
    return removed ? "removed" : "refused";
  }

  const normalized = normalizeLinkHref(href);
  if (!normalized) return "invalid";

  if (!draft.needsText) {
    const applied = editor
      .chain()
      .focus()
      .setTextSelection(range)
      .setLink({ href: normalized, title: null })
      .run();
    return applied ? "applied" : "refused";
  }

  // Nothing was selected, so the commit writes the link's own text. A URL with
  // no label reads as itself, which is what pasting a bare link produces.
  const text = commit.text.trim() || normalized;
  const applied = editor
    .chain()
    .focus()
    .insertContentAt(range, {
      type: "text",
      text,
      marks: linkTextMarks(editor, draft, normalized).map((mark) => ({
        type: mark.type.name,
        attrs: mark.attrs,
      })),
    })
    .run();
  return applied ? "applied" : "refused";
}

/** Drop the link mark over a range the pointer chose, not the caret (§5.5). */
export function removeLinkAt(editor: Editor, range: { from: number; to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  return editor.chain().focus().setTextSelection(range).unsetLink().run();
}

/**
 * The marks the rewritten text should carry. Rewriting a link's text replaces
 * real content, so everything that content already wore comes with it: a bold
 * link stays bold, and only the link mark itself is exchanged.
 */
function linkTextMarks(editor: Editor, draft: LinkDraft, href: string): Mark[] {
  const { state } = editor;
  const linkType = state.schema.marks.link;
  const $from = state.doc.resolve(draft.from);
  const existing = draft.existing
    ? ($from.nodeAfter?.marks ?? [])
    : (state.storedMarks ?? $from.marks());

  const kept = existing.filter((mark) => mark.type !== linkType);
  return linkType ? [...kept, linkType.create({ href, title: null })] : kept;
}
