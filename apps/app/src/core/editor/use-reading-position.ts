import { loroSyncKey, REMOTE_META } from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import type { DocumentSession } from "./document-session";
import { captureReadingPosition, restoreReadingPosition } from "./reading-position";
import {
  markRestoredPlace,
  mayRestoreReadingPosition,
  reportEditorMounted,
} from "./reading-position-navigation";
import { ReadingPositionStore } from "./reading-position-store";

export function useReadingPosition({
  editor,
  pane,
  accountId,
  documentId,
  active,
  session,
  signal,
}: {
  editor: Editor | null;
  pane: RefObject<HTMLDivElement | null>;
  accountId: string;
  documentId: string;
  active: boolean;
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
    const key = session.roomKey;
    let stop: (() => void) | null = null;
    let unreport: (() => void) | null = null;
    const begin = () => {
      // A mount with no layout yet (hidden warm, or an editor that remounted before its pane was
      // measured) begins once it has some: its first reveal is its first restoration.
      if (stop || !active || !scroller.clientHeight) return;
      if (initialized.current !== editor) {
        initialized.current = editor;
        const place = mayRestoreReadingPosition(editor, documentId) ? store.load(key) : null;
        // A frame later, past the commit: React's development double mount remounts the editor
        // content, which redraws the prose and drops any scroll set before it.
        if (place) {
          markRestoredPlace(editor);
          requestAnimationFrame(() => restoreReadingPosition(editor, scroller, place));
        }
      }
      stop = track(editor, scroller);
      unreport = reportEditorMounted(documentId, editor);
    };
    const track = (editor: Editor, scroller: HTMLDivElement) => {
      let moved: number | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let restoring = true;
      // The browser delivers restoration's scroll event asynchronously.
      const frame = requestAnimationFrame(() => {
        restoring = false;
      });
      // Measured once the place settles, not per keystroke: measuring reads the layout.
      const flush = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        const place =
          moved !== null && !signal.aborted ? captureReadingPosition(editor, scroller) : null;
        if (place && moved !== null) store.save(key, place, moved);
        moved = null;
      };
      const save = () => {
        if (restoring || !visible.current || signal.aborted || !scroller.clientHeight) return;
        moved = performance.timeOrigin + performance.now();
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 200);
      };
      const selection = ({ transaction }: { transaction: Transaction }) => {
        if (
          transaction.getMeta(loroSyncKey) !== REMOTE_META &&
          (editor.isFocused || transaction.selectionSet)
        )
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
    };
    begin();
    const layout = new ResizeObserver(begin);
    layout.observe(scroller);
    return () => {
      layout.disconnect();
      stop?.();
      unreport?.();
    };
  }, [editor, pane, store, documentId, active, session, signal]);
}
