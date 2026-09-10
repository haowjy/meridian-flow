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
import { closeHistory } from "@tiptap/pm/history";
import type { Mark } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

import {
  anchorRange,
  type EditorAnchor,
  followAnchor,
  resolveAnchor,
  resolveAnchorIn,
} from "../anchors";
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
  identity: Mark | null;
  /**
   * A bare caret has no content to preserve; a destination-only edit otherwise
   * updates the mark without flattening the selected prose.
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
      identity: null,
      needsText: empty,
      text: editor.state.doc.textBetween(from, to),
      href: "",
    };
  }

  return {
    ...anchorLinkRange(editor.state, { from: link.from, to: link.to }),
    existing: true,
    identity: link.identity,
    needsText: false,
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
  if (!at || (draft.existing && at.from === at.to)) return null;
  if (draft.identity && !linkAt(state, at.from + 1)?.identity.eq(draft.identity)) return null;
  return { ...draft, ...at };
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

  const range = resolveAnchorIn(editor.state, draft);
  if (!range || (draft.existing && range.from === range.to)) return "refused";
  if (draft.identity && !linkAt(editor.state, range.from + 1)?.identity.eq(draft.identity))
    return "refused";
  const href = commit.href.trim();
  if (!href) {
    if (!draft.existing) return "invalid";
    const removed = runLinkEdit(editor, () =>
      editor.chain().focus().setTextSelection(range).unsetLink().run(),
    );
    return removed ? "removed" : "refused";
  }

  const normalized = normalizeLinkHref(href);
  if (!normalized) return "invalid";

  if (!draft.needsText && (!commit.text.trim() || commit.text === draft.text)) {
    const applied = runLinkEdit(editor, () =>
      editor
        .chain()
        .focus()
        .setTextSelection(range)
        .setLink({ href: normalized, title: null })
        .run(),
    );
    return applied ? "applied" : "refused";
  }

  const text = commit.text.trim() || normalized;
  const applied = runLinkEdit(editor, () => {
    const { state } = editor;
    const linkType = state.schema.marks.link;
    if (!linkType) return false;
    const original = state.doc.textBetween(range.from, range.to);
    const before = Array.from(original);
    const after = Array.from(text);
    let prefix = 0;
    let suffix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix])
      prefix += 1;
    while (
      suffix < Math.min(before.length, after.length) - prefix &&
      before[before.length - suffix - 1] === after[after.length - suffix - 1]
    )
      suffix += 1;
    const from = range.from + before.slice(0, prefix).join("").length;
    const to = range.to - before.slice(before.length - suffix).join("").length;
    const inserted = after.slice(prefix, after.length - suffix).join("");
    // Surviving text keeps its mark runs. New wording inherits only marks
    // common to the replaced slice, never formatting sampled from its first word.
    let marks: readonly Mark[] | undefined;
    state.doc.nodesBetween(from, to, (node) => {
      if (!node.isInline) return;
      marks = marks ? marks.filter((mark) => mark.isInSet(node.marks)) : node.marks;
    });
    marks ??= state.storedMarks ?? state.doc.resolve(from).marks();
    const tr = state.tr;
    if (inserted) tr.replaceWith(from, to, state.schema.text(inserted, marks));
    else tr.delete(from, to);
    tr.addMark(
      range.from,
      range.from + text.length,
      linkType.create({ href: normalized, title: null }),
    );
    editor.view.dispatch(tr);
    editor.commands.focus();
    return true;
  });
  return applied ? "applied" : "refused";
}

/**
 * Whether the writer's own selection already covers this link.
 *
 * A clipboard verb on the link menu has two possible subjects, and the writer
 * decides which by what they swept before right-clicking. The link rung
 * outranks the selection rung (§5.1), so a writer who selected a sentence
 * containing a link and right-clicked the link still gets the LINK menu — and
 * a Cut there that took only the link would throw away the sentence they had
 * chosen.
 */
export function selectionCoversLink(
  state: EditorState,
  range: { from: number; to: number },
): boolean {
  const { selection } = state;
  return !selection.empty && selection.from <= range.from && selection.to >= range.to;
}

/** Drop the link mark over a range the pointer chose, not the caret (§5.5). */
export function removeLinkAt(editor: Editor, range: { from: number; to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  return runLinkEdit(editor, () =>
    editor.chain().focus().setTextSelection(range).unsetLink().run(),
  );
}

/** A summoned link action is one undo unit, separate from typing on either side. */
function runLinkEdit(editor: Editor, apply: () => boolean): boolean {
  const boundary = () => {
    yUndoPluginKey.getState(editor.state)?.undoManager.stopCapturing();
    editor.view.dispatch(closeHistory(editor.state.tr));
  };
  boundary();
  const applied = apply();
  boundary();
  return applied;
}
