/**
 * The sessions of the documents the writer has open, kept for their undo.
 *
 * A session owns its document's undo, so keeping the session keeps the undo for a tab the
 * writer comes back to. A tab is kept by an open-content lease, the same one a host takes.
 * A tab on screen is held; one that left the screen is held only while its history has
 * something to undo or redo, so reading other tabs never evicts a document the writer edited.
 * `OPEN_TAB_SESSION_CAP` bounds the off-screen ones, the least recently edited going first.
 * A closed tab drops at once. A tab that is not shown this visit, and a review-mode tab (it
 * edits the draft room's session), is not held.
 */
import { useEffect, useRef } from "react";
import type { DocumentHistory } from "@/core/editor/editor-history";
import { useAccountResourceReplica } from "./account-feature-context";

export const OPEN_TAB_SESSION_CAP = 8;
const OPEN_RETRY_MS = 5_000;

type Held = {
  release(): void;
  history: DocumentHistory | null;
  /** Order of the last history change; the least recent goes first past the cap. */
  edited: number;
};

export function useOpenTabSessions(
  projectId: string,
  tabs: readonly { document: { documentId: string } }[],
  shown: readonly { documentId: string }[],
): void {
  const resources = useAccountResourceReplica();
  const held = useRef(new Map<string, Held>());
  const want = useRef({ open: new Set<string>(), showing: new Set<string>() });
  const clock = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const reconcile = useRef(() => {});
  reconcile.current = () => {
    const { open, showing } = want.current;
    const withHistory = [...held.current]
      .filter(([id, tab]) => open.has(id) && !showing.has(id) && tab.history?.hasEntries())
      .sort(([, a], [, b]) => b.edited - a.edited)
      .slice(0, OPEN_TAB_SESSION_CAP)
      .map(([id]) => id);
    const keep = new Set([...showing, ...withHistory]);
    for (const [documentId, tab] of held.current) {
      if (open.has(documentId) && keep.has(documentId)) continue;
      held.current.delete(documentId);
      tab.release();
    }
    for (const documentId of showing) {
      if (open.has(documentId) && !held.current.has(documentId)) hold(documentId);
    }
  };

  const hold = (documentId: string) => {
    const abort = new AbortController();
    let binding: { release(): void } | null = null;
    let stopWatching = () => {};
    const tab: Held = {
      history: null,
      edited: 0,
      release: () => {
        abort.abort();
        stopWatching();
        binding?.release();
      },
    };
    held.current.set(documentId, tab);
    // A failed open leaves nothing held, so the next pass opens it again while the tab is wanted.
    const failed = () => {
      if (abort.signal.aborted || held.current.get(documentId) !== tab) return;
      held.current.delete(documentId);
      clearTimeout(retry.current);
      retry.current = setTimeout(() => reconcile.current(), OPEN_RETRY_MS);
    };
    void (async () => {
      const key = await resources.keyForDocument(projectId, documentId);
      if (!key || abort.signal.aborted) return failed();
      const opened = await resources.openDocument(
        projectId,
        key,
        `open-tab:${documentId}`,
        abort.signal,
      );
      if (opened.kind !== "opened") return failed();
      if (abort.signal.aborted) return opened.handle.release();
      binding = opened.handle;
      const { history } = opened.handle.session;
      tab.history = history;
      stopWatching = history.subscribe(() => {
        tab.edited = ++clock.current;
        reconcile.current();
      });
      reconcile.current();
    })().catch((error: unknown) => {
      failed();
      reportError(error);
    });
  };

  useEffect(() => {
    want.current = {
      open: new Set(tabs.map((tab) => tab.document.documentId)),
      showing: new Set(shown.map((tab) => tab.documentId)),
    };
    reconcile.current();
  }, [shown, tabs]);

  useEffect(
    () => () => {
      clearTimeout(retry.current);
      for (const tab of held.current.values()) tab.release();
      held.current.clear();
    },
    [],
  );
}
