/**
 * The open review's changes in suggestion mode: the Work's suggestions in the editor's document
 * (`list`), in the shape the draft review's surfaces read (`ReviewChange`), so the band, the
 * change bar, the Changes list's rows and the phone's sheet draw them as they draw a draft's.
 * Who wrote each one comes from the document's authors (`authorsIn`), its chat's title from the
 * owner's list.
 */
import { t } from "@lingui/core/macro";
import type { Author } from "@meridian/agent-edit/diff";
import type { ThreadDraftListItem } from "@meridian/contracts/branches";
import { type Change, list } from "@meridian/suggestions";
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  authorsIn,
  SUGGESTION_CHANGE_ATTR,
} from "@/core/editor/extensions/suggestion-mode";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import type { ChatRef, ReviewChange } from "@/features/draft-review/review-model";
import { resolveFocusedChange } from "@/features/draft-review/review-model";


/** The editor's document, read again on every transaction. */
function useEditorDoc(editor: Editor | null) {
  return useSyncExternalStore(
    (listener) => {
      if (!editor) return () => undefined;
      editor.on("transaction", listener);
      return () => void editor.off("transaction", listener);
    },
    () => (editor && !editor.isDestroyed ? editor.state.doc : null),
    () => null,
  );
}

/** `work`'s changes in the editor's document, in document order; empty while there is no editor. */
export function useSuggestionChanges(
  editor: Editor | null,
  work: string,
  item: Pick<ThreadDraftListItem, "actorThreads"> | undefined,
): { ready: boolean; changes: ReviewChange[] } {
  const doc = useEditorDoc(editor);
  const titles = item?.actorThreads;
  return useMemo(() => {
    if (!doc || !editor || !work) return { ready: false, changes: [] };
    const named = new Map((titles ?? []).map((chat) => [chat.threadId, chat.title ?? ""]));
    return {
      ready: true,
      changes: list(doc, { work }, authorsIn(editor.state)).map((change) =>
        reviewChange(change, named),
      ),
    };
  }, [doc, editor, work, titles]);
}

function reviewChange(change: Change, titles: ReadonlyMap<string, string>): ReviewChange {
  const byline: Author[] = [];
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
  const removed = change.deleted.replace(/\n+/g, " ").trim();
  const inserted = change.inserted.replace(/\n+/g, " ").trim();
  return {
    id: change.id,
    kind: "change",
    // A change of a block's kind alone (a heading's level, a list) has no words to quote.
    excerpt: removed || inserted ? { removed, inserted } : { removed: "", inserted: t`Formatting` },
    byline,
    chats,
    members: chats.map((chat) => chat.chatId),
    attributed: true,
    anchor: change.from,
    spans: [],
    frame: null,
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
      const target = (event.target as Element | null)?.closest(`[${SUGGESTION_CHANGE_ATTR}]`);
      const id = target?.getAttribute(SUGGESTION_CHANGE_ATTR);
      if (id) reportFocusedChange({ documentId, itemKey }, { id, frame: null });
    };
    const dom = live.view.dom;
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [live, documentId, itemKey, reportFocusedChange]);
}

