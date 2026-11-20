/**
 * The open review's changes in suggestion mode: the Work's suggestions in the editor's document
 * (`list`), in the shape the draft review's surfaces read (`ReviewChange`), so the band, the
 * change bar, the Changes list's rows and the phone's sheet draw them as they draw a draft's.
 * Who wrote each one comes from the document's authors (`authorsIn`), its chat's title from the
 * owner's list.
 */
import { t } from "@lingui/core/macro";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type Change, list, sameValue } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { startTransition, useEffect, useMemo, useState } from "react";
import { authorsIn, SUGGESTION_CHANGE_ATTR } from "@/core/editor/extensions/suggestion-mode";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { BylineEntry, ChatRef, ReviewChange } from "@/features/draft-review/review-model";
import { resolveFocusedChange } from "@/features/draft-review/review-model";

/**
 * The editor's document, read again after each transaction as a transition: the review redraws
 * after the keystroke has painted, and a later keystroke interrupts it, so typing never waits on
 * the review's surfaces. They trail the text by a frame.
 */
function useEditorDoc(editor: Editor | null): Node | null {
  const [read, setRead] = useState<{ editor: Editor; doc: Node } | null>(null);
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (editor.isDestroyed) return;
      const doc = editor.state.doc;
      // A selection alone leaves the document, and so the review, as it was.
      startTransition(() =>
        setRead((was) => (was?.editor === editor && was.doc === doc ? was : { editor, doc })),
      );
    };
    update();
    editor.on("transaction", update);
    return () => void editor.off("transaction", update);
  }, [editor]);
  if (!editor || editor.isDestroyed) return null;
  return read?.editor === editor ? read.doc : editor.state.doc;
}

type Shown = {
  doc: Node;
  changes: ReviewChange[];
  rows: Map<string, { source: Change; title: string; row: ReviewChange }>;
};

/**
 * Each editor's last list per Work, shared by every surface reading it (the band, the bar, the
 * list, the host): a review walks the document once per keystroke, not once per reader. A change's
 * author is written in the same transaction as its marks, so the document node is enough of a key.
 * A change that reads the same keeps its row, and an unchanged list keeps its array, so the
 * surfaces redraw only for what moved.
 */
const shown = new WeakMap<Editor, Map<string, Shown>>();
/** Chat titles by id, kept per editor: a pressed row's chats keep their names until its Undo's read lands. */
const titlesOf = new WeakMap<Editor, Map<string, string>>();

function shownChanges(editor: Editor, doc: Node, work: string): ReviewChange[] {
  const byWork = shown.get(editor) ?? new Map<string, Shown>();
  shown.set(editor, byWork);
  const was = byWork.get(work);
  if (was?.doc === doc) return was.changes;
  const titles = titlesOf.get(editor) ?? new Map<string, string>();
  const rows: Shown["rows"] = new Map();
  const changes = list(doc, { work }, authorsIn(editor.state)).map((source) => {
    const title = source.chat ? (titles.get(source.chat) ?? "") : "";
    const old = was?.rows.get(source.id);
    const row =
      old && old.title === title && sameChange(old.source, source)
        ? old.row
        : reviewChange(source, titles);
    rows.set(source.id, { source, title, row });
    return row;
  });
  const same =
    was &&
    changes.length === was.changes.length &&
    changes.every((row, i) => row === was.changes[i]);
  const next = { doc, changes: same ? was.changes : changes, rows };
  byWork.set(work, next);
  return next.changes;
}

/** Whether two reads of a change show the same row: its position alone does not. */
function sameChange(a: Change, b: Change): boolean {
  return (
    a.inserted === b.inserted &&
    a.deleted === b.deleted &&
    a.chat === b.chat &&
    a.turn === b.turn &&
    a.by === b.by &&
    sameValue(a.attrs, b.attrs)
  );
}

/** `work`'s changes in the editor's document, in document order; empty while there is no editor. */
export function useSuggestionChanges(
  editor: Editor | null,
  work: string,
  item: Pick<ThreadDraftListItem, "actorThreads"> | undefined,
): { ready: boolean; changes: ReviewChange[] } {
  const doc = useEditorDoc(editor);
  const actors = item?.actorThreads;
  return useMemo(() => {
    if (!doc || !editor || !work) return { ready: false, changes: [] };
    const titles = titlesOf.get(editor) ?? new Map<string, string>();
    titlesOf.set(editor, titles);
    let renamed = false;
    for (const chat of actors ?? []) {
      const title = chat.title ?? "";
      renamed ||= titles.get(chat.threadId) !== title;
      titles.set(chat.threadId, title);
    }
    if (renamed) shown.get(editor)?.delete(work);
    return { ready: true, changes: shownChanges(editor, doc, work) };
  }, [doc, editor, work, actors]);
}

/** One line, clipped to 120 characters. */
function excerptOf(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
}

function reviewChange(change: Change, titles: ReadonlyMap<string, string>): ReviewChange {
  const byline: BylineEntry[] = [];
  const chats: ChatRef[] = [];
  if (change.chat && change.turn) {
    byline.push({ kind: "thread", threadId: change.chat, turnId: change.turn });
    chats.push({
      chatId: change.chat,
      title: titles.get(change.chat) ?? "",
      reveal: { threadId: change.chat, turnId: change.turn },
    });
  }
  if (change.by?.startsWith("user:")) byline.push({ kind: "user", userId: change.by.slice(5) });
  const removed = excerptOf(change.deleted);
  const inserted = excerptOf(change.inserted);
  return {
    id: change.id,
    // A change of a block's kind alone (a heading's level, a list) has no words to quote.
    excerpt: removed || inserted ? { removed, inserted } : { removed: "", inserted: t`Formatting` },
    byline,
    chats,
    members: chats.map((chat) => chat.chatId),
    attributed: true,
  };
}

/**
 * Keeps the editor's paint and the review saying the same thing: the review's focused change is
 * the one emphasized, and a click on a change's marks focuses it everywhere (the list, the
 * stepper, the bar). Registers the editor as the review's, so the review's focus commands reach it.
 */
export function useSuggestionReviewFocus({
  editor,
  documentId,
  itemKey,
  changes,
}: {
  editor: Editor | null;
  documentId: string;
  itemKey: string | null;
  changes: readonly ReviewChange[];
}): void {
  const { controller } = useDraftReview();
  const { registerInlineReviewRuntime, releaseInlineReviewRuntime, reportFocusedChange } =
    controller;
  const live = editor && !editor.isDestroyed && itemKey ? editor : null;

  useEffect(() => {
    if (!live || !itemKey) return;
    registerInlineReviewRuntime({ editor: live, documentId, itemKey });
    return () => releaseInlineReviewRuntime(live);
  }, [live, documentId, itemKey, registerInlineReviewRuntime, releaseInlineReviewRuntime]);

  const focused = live
    ? (resolveFocusedChange(changes, controller.focus) ?? changes[0] ?? null)
    : null;
  const active = focused?.id ?? null;
  useEffect(() => {
    live?.commands.setReviewActiveChange(active);
  }, [live, active]);

  useEffect(() => {
    if (!live || !itemKey) return;
    const onClick = (event: MouseEvent) => {
      // Changes not marked read as applied: a click in their text is a click in text.
      if (!controller.marksVisible) return;
      const target = (event.target as Element | null)?.closest(`[${SUGGESTION_CHANGE_ATTR}]`);
      const id = target?.getAttribute(SUGGESTION_CHANGE_ATTR);
      if (id) reportFocusedChange({ documentId, itemKey }, { id });
    };
    const dom = live.view.dom;
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [live, documentId, itemKey, reportFocusedChange, controller.marksVisible]);
}
