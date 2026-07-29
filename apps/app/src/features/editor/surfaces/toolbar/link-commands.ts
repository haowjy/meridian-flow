/**
 * Link resolution and commit for the toolbar's link popover.
 *
 * The popover asks two questions of the editor — what is under the selection,
 * and what should the commit do about it — and both answers live here so the
 * form stays a form. The P2 link lane (Ctrl+K, wikilink autocomplete) absorbs
 * this module rather than growing a parallel one.
 */
import type { Editor } from "@tiptap/core";

import { normalizeLinkHref } from "@/core/editor/link-url";
import { linkAtSelection } from "../../link-selection";

export type LinkDraft = {
  /** Range the commit rewrites: the selection, or the whole existing link. */
  from: number;
  to: number;
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

/** What the popover should show for the current selection. */
export function resolveLinkDraft(editor: Editor): LinkDraft {
  const { empty, from, to } = editor.state.selection;
  const link = linkAtSelection(editor);
  if (!link) return { from, to, existing: false, needsText: empty, text: "", href: "" };

  return {
    from: link.from,
    to: link.to,
    existing: true,
    needsText: empty,
    text: editor.state.doc.textBetween(link.from, link.to),
    href: String(link.attributes.href ?? ""),
  };
}

/**
 * Enter commits; an emptied URL over an existing link removes it (§5.5).
 * Returns what happened so the popover can stay open on an unusable URL
 * instead of closing over a change it never made.
 */
export function commitLinkDraft(
  editor: Editor,
  draft: LinkDraft,
  commit: LinkCommit,
): LinkCommitResult {
  if (editor.isDestroyed || !editor.isEditable) return "refused";

  const href = commit.href.trim();
  if (!href) {
    if (!draft.existing) return "invalid";
    editor.chain().focus().setTextSelection({ from: draft.from, to: draft.to }).unsetLink().run();
    return "removed";
  }

  const normalized = normalizeLinkHref(href);
  if (!normalized) return "invalid";

  if (!draft.needsText) {
    editor
      .chain()
      .focus()
      .setTextSelection({ from: draft.from, to: draft.to })
      .setLink({ href: normalized, title: null })
      .run();
    return "applied";
  }

  // Nothing was selected, so the commit writes the link's own text. A URL with
  // no label reads as itself, which is what pasting a bare link produces.
  const text = commit.text.trim() || normalized;
  editor
    .chain()
    .focus()
    .insertContentAt(
      { from: draft.from, to: draft.to },
      { type: "text", text, marks: [{ type: "link", attrs: { href: normalized, title: null } }] },
    )
    .run();
  return "applied";
}
