/**
 * Link resolution and commit for the toolbar's link popover.
 *
 * The popover asks three things of the editor — what is under the selection,
 * where that range has moved to since, and what the commit should do about
 * it — and all three answers live here so the form stays a form. The P2 link
 * lane (Ctrl+K, wikilink autocomplete) absorbs this module rather than growing
 * a parallel one.
 */
import type { Editor } from "@tiptap/core";
import type { Mark } from "@tiptap/pm/model";
import type { Mappable } from "@tiptap/pm/transform";

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
 * Where the draft's range sits after a document change. A popover is open for
 * as long as the writer takes to type a URL, and the document moves underneath
 * it — a peer types above the selection, an AI write lands — so raw positions
 * go stale and would address whatever slid into their place. Both edges bias
 * away from the range: text typed against either boundary belongs to the
 * document, not to the phrase the writer selected.
 */
export function mapLinkDraft(draft: LinkDraft, mapping: Mappable): LinkDraft {
  return { ...draft, from: mapping.map(draft.from, 1), to: mapping.map(draft.to, -1) };
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
