/**
 * The sessions of the documents the writer has open, kept for their undo.
 *
 * A session owns its document's undo, so keeping the session keeps the undo for a tab
 * the writer comes back to. A tab is kept by an open-content lease, the same one a host takes.
 * Only tabs shown this visit are kept, most recently shown first and at most
 * `OPEN_TAB_SESSION_CAP`; past it the oldest drops its session, never its tab. A closed
 * tab drops at once.
 */
import { useEffect, useRef } from "react";
import { useAccountResourceReplica } from "./account-feature-context";

export const OPEN_TAB_SESSION_CAP = 8;

export function useOpenTabSessions(
  projectId: string,
  tabs: readonly { document: { documentId: string } }[],
  shown: readonly { documentId: string }[],
): void {
  const resources = useAccountResourceReplica();
  /** Most recently shown first. */
  const visited = useRef<string[]>([]);
  const retained = useRef(new Map<string, () => void>());

  useEffect(() => {
    const open = new Set(tabs.map((tab) => tab.document.documentId));
    const showing = new Set(shown.map((tab) => tab.documentId));
    visited.current = [
      ...showing,
      ...visited.current.filter((documentId) => !showing.has(documentId)),
    ]
      .filter((documentId) => open.has(documentId))
      .slice(0, OPEN_TAB_SESSION_CAP);
    const wanted = new Set(visited.current);
    for (const [documentId, release] of retained.current) {
      if (wanted.has(documentId)) continue;
      retained.current.delete(documentId);
      release();
    }
    for (const documentId of wanted) {
      if (retained.current.has(documentId)) continue;
      const abort = new AbortController();
      let binding: { release(): void } | null = null;
      retained.current.set(documentId, () => {
        abort.abort();
        binding?.release();
      });
      void (async () => {
        const key = await resources.keyForDocument(projectId, documentId);
        if (!key || abort.signal.aborted) return;
        const opened = await resources.openDocument(
          projectId,
          key,
          `open-tab:${documentId}`,
          abort.signal,
        );
        if (opened.kind !== "opened") return;
        if (abort.signal.aborted) opened.handle.release();
        else binding = opened.handle;
      })().catch(reportError);
    }
  }, [resources, projectId, shown, tabs]);

  useEffect(
    () => () => {
      for (const release of retained.current.values()) release();
      retained.current.clear();
    },
    [],
  );
}
