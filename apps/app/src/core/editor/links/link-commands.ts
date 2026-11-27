import type { DocumentRef, FolderRef } from "@meridian/contracts";
import { type Editor, getMarkRange } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import {
  anchorRange,
  type EditorAnchor,
  followAnchor,
  resolveAnchor,
  resolveAnchorIn,
} from "../anchors";
import { endUndoStep } from "../editor-history";
import { assignWrittenHref } from "./link-assignment";
import { linkKeyOfMark } from "./link-resolution";
import { getLinkAnswerCache } from "./link-storage";
import { normalizeLinkHref } from "./link-target";

export function linkText(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): { text: string; at(offset: number, side: -1 | 1): number } {
  const runs: Array<{ offset: number; pos: number; length: number }> = [];
  let text = "";
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return;
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    runs.push({ offset: text.length, pos: start, length: end - start });
    text += (node.text ?? "").slice(start - pos, end - pos);
  });
  const at = (offset: number, side: -1 | 1) => {
    const run =
      (side < 0
        ? runs.find((r) => offset > r.offset && offset <= r.offset + r.length)
        : runs.find((r) => offset >= r.offset && offset < r.offset + r.length)) ??
      (side < 0 ? runs[0] : runs.at(-1));
    return run ? run.pos + Math.max(0, Math.min(run.length, offset - run.offset)) : from;
  };
  return { text, at };
}

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

export function linkAtSelection(editor: Editor): LinkSelection | null {
  const { selection } = editor.state;
  if (!editor.schema.marks.link) return null;
  if (!selection.empty && !editor.isActive("link")) return null;
  return linkAt(editor.state, selection.from);
}

export function linkAt(state: EditorState, pos: number): LinkSelection | null {
  const linkType = state.schema.marks.link;
  // Callers arrive with positions a stored cursor resolved to, which can sit
  // at the very end of the document, and with the character after them.
  // Resolving off the end throws inside the binding's update handler, and the
  // editor stops applying peer writes.
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

export type LinkAnchor = EditorAnchor;

export const anchorLinkRange = anchorRange;

export const resolveLinkAnchor = resolveAnchor;

export type LinkDraft = LinkAnchor & {
  existing: boolean;
  identity: Mark | null;
  needsText: boolean;
  text: string;
  href: string;
};

export type LinkCommit = {
  text: string;
  href: string;
  ref?: DocumentRef | FolderRef;
};

export type LinkCommitResult = "applied" | "removed" | "invalid" | "refused";

export function resolveLinkDraft(editor: Editor): LinkDraft {
  const { empty, from, to } = editor.state.selection;
  const link = linkAtSelection(editor);
  if (!link) {
    return {
      ...anchorLinkRange(editor.state, { from, to }),
      existing: false,
      identity: null,
      needsText: empty,
      text: linkText(editor.state.doc, from, to).text,
      href: "",
    };
  }

  return {
    ...anchorLinkRange(editor.state, { from: link.from, to: link.to }),
    existing: true,
    identity: link.identity,
    needsText: false,
    text: linkText(editor.state.doc, link.from, link.to).text,
    href: linkKeyOfMark(link.attributes).href,
  };
}

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

export function relocateLink(
  state: EditorState,
  link: { anchor: LinkAnchor; identity: Mark },
  mapping: Mappable,
): LinkSelection | null {
  const at = resolveLinkAnchor(state, link.anchor, mapping);
  if (!at) return null;

  const current = linkAt(state, at.from + 1);
  return current?.identity.eq(link.identity) ? current : null;
}

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
  const attrs = committedLinkAttrs(editor, draft, normalized, commit.ref);

  if (!draft.needsText && (!commit.text.trim() || commit.text === draft.text)) {
    const applied = runLinkEdit(editor, () =>
      editor.chain().focus().setTextSelection(range).setLink(attrs).run(),
    );
    return applied ? "applied" : "refused";
  }

  const text = commit.text.trim() || normalized;
  const applied = runLinkEdit(editor, () => {
    const { state } = editor;
    const linkType = state.schema.marks.link;
    if (!linkType) return false;
    const shown = linkText(state.doc, range.from, range.to);
    const before = Array.from(shown.text);
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
    const from = shown.at(before.slice(0, prefix).join("").length, 1);
    const to = shown.at(before.slice(0, before.length - suffix).join("").length, -1);
    const inserted = after.slice(prefix, after.length - suffix).join("");
    let marks: readonly Mark[] | undefined;
    state.doc.nodesBetween(from, to, (node) => {
      if (!node.isInline) return;
      marks = marks ? marks.filter((mark) => mark.isInSet(node.marks)) : node.marks;
    });
    marks ??= state.storedMarks ?? state.doc.resolve(from).marks();
    const tr = state.tr;
    if (inserted) tr.replaceWith(from, to, state.schema.text(inserted, marks));
    else tr.delete(from, to);
    tr.addMark(range.from, tr.mapping.map(range.to), linkType.create(attrs));
    editor.view.dispatch(tr);
    editor.commands.focus();
    return true;
  });
  return applied ? "applied" : "refused";
}

function committedLinkAttrs(
  editor: Editor,
  draft: LinkDraft,
  href: string,
  picked: DocumentRef | FolderRef | undefined,
): { href: string; title: string | null; ref: string | null } {
  if (!picked && draft.existing && draft.identity && href === draft.href) {
    const { attrs } = draft.identity;
    const stored = linkKeyOfMark(attrs);
    return {
      href: stored.href || href,
      title: typeof attrs.title === "string" ? attrs.title : null,
      ref: stored.ref,
    };
  }
  if (picked) return { href, title: null, ref: picked };
  const scope = getLinkAnswerCache(editor)?.assignment;
  return {
    ...assignWrittenHref(href, scope?.holderUri ?? null, scope?.index ?? null),
    title: null,
  };
}

export function selectionCoversLink(
  state: EditorState,
  range: { from: number; to: number },
): boolean {
  const { selection } = state;
  return !selection.empty && selection.from <= range.from && selection.to >= range.to;
}

export function removeLinkAt(editor: Editor, range: { from: number; to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  return runLinkEdit(editor, () =>
    editor.chain().focus().setTextSelection(range).unsetLink().run(),
  );
}

function runLinkEdit(editor: Editor, apply: () => boolean): boolean {
  endUndoStep(editor.state);
  const applied = apply();
  endUndoStep(editor.state);
  return applied;
}
