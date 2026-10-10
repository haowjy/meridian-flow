/** Per-mounted-view device memory; warm tabs retain their existing DOM and place. */
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import { captureReadingPosition, restoreReadingPosition } from "./reading-position";
import { mayRestoreReadingPosition } from "./reading-position-navigation";
import { type ReadingPosition, ReadingPositionStore } from "./reading-position-store";

export function useReadingPosition({
  editor,
  pane,
  accountId,
  documentId,
  active,
  review,
  signal,
}: {
  editor: Editor | null;
  pane: RefObject<HTMLDivElement | null>;
  accountId: string;
  documentId: string;
  active: boolean;
  review: boolean;
  signal: AbortSignal;
}): void {
  const store = useMemo(() => new ReadingPositionStore(accountId), [accountId]);
  const visible = useRef(active);
  visible.current = active;
  const initialized = useRef<Editor | null>(null);

  useLayoutEffect(() => {
    const scroller = pane.current;
    if (!editor || !scroller || review || signal.aborted) return;
    if (initialized.current !== editor) {
      // Hidden warm mounts have no layout. Their first reveal is their first restoration.
      if (!active || !scroller.clientHeight) return;
      initialized.current = editor;
      if (mayRestoreReadingPosition(editor, documentId, review, window.location.href)) {
        const place = store.load(documentId);
        if (place) restoreReadingPosition(editor, scroller, place);
      }
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
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", save);
      editor.off("selectionUpdate", selection);
      window.removeEventListener("pagehide", flush);
    };
  }, [editor, pane, store, documentId, active, review, signal]);
}
