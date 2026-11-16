/** Per-mounted-view device memory; a kept document retains their existing DOM and place. */
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import type { DocumentSession } from "./document-session";
import { captureReadingPosition, restoreReadingPosition } from "./reading-position";
import { mayRestoreReadingPosition } from "./reading-position-navigation";
import { type ReadingPosition, ReadingPositionStore } from "./reading-position-store";

/**
 * A review mount keeps no place between visits. Across a replaced session (a room that came back
 * read-only and was rebuilt from the server) its editor remounts, and the place carries over here:
 * the anchors are Yjs relative positions, which resolve in the new document for every item the
 * server has, and one inside dropped text falls back to the top.
 */
const carried = new Map<string, ReadingPosition>();

export function useReadingPosition({
  editor,
  pane,
  accountId,
  documentId,
  active,
  review,
  session,
  signal,
}: {
  editor: Editor | null;
  pane: RefObject<HTMLDivElement | null>;
  accountId: string;
  documentId: string;
  active: boolean;
  review: boolean;
  session: DocumentSession;
  signal: AbortSignal;
}): void {
  const store = useMemo(() => new ReadingPositionStore(accountId), [accountId]);
  const visible = useRef(active);
  visible.current = active;
  const initialized = useRef<Editor | null>(null);

  useLayoutEffect(() => {
    const scroller = pane.current;
    if (!editor || !scroller || signal.aborted) return;
    const carryKey = `${accountId}|${session.roomKey}`;
    if (initialized.current !== editor) {
      // Hidden warm mounts have no layout. Their first reveal is their first restoration.
      if (!active || !scroller.clientHeight) return;
      initialized.current = editor;
      const place = review
        ? carried.get(carryKey)
        : mayRestoreReadingPosition(editor, documentId, review, window.location.href)
          ? store.load(documentId)
          : null;
      carried.delete(carryKey);
      // A frame later, past the commit: React's development double mount remounts the editor
      // content, which redraws the prose and drops any scroll set before it.
      if (place) requestAnimationFrame(() => restoreReadingPosition(editor, scroller, place));
    }
    let candidate: { place: ReadingPosition; at: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let restoring = true;
    // The browser delivers restoration's scroll event asynchronously.
    const frame = requestAnimationFrame(() => {
      restoring = false;
    });
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (candidate && !signal.aborted) store.save(documentId, candidate.place, candidate.at);
      candidate = null;
    };
    const save = () => {
      if (restoring || !visible.current || signal.aborted || !scroller.clientHeight) return;
      const place = captureReadingPosition(editor, scroller);
      if (!place) return;
      if (review) {
        carried.set(carryKey, place);
        return;
      }
      candidate = { place, at: performance.timeOrigin + performance.now() };
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 200);
    };
    const selection = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.getMeta(ySyncPluginKey) && (editor.isFocused || transaction.selectionSet))
        save();
    };
    scroller.addEventListener("scroll", save, { passive: true });
    editor.on("selectionUpdate", selection);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      if (review && !session.replaced) carried.delete(carryKey);
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", save);
      editor.off("selectionUpdate", selection);
      window.removeEventListener("pagehide", flush);
    };
  }, [editor, pane, store, accountId, documentId, active, review, session, signal]);
}
