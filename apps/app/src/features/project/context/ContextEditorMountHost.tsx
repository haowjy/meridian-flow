/** ContextEditorMountHost — hosts the *active* TRACKED context document with a bounded "keep-warm" set of recently-viewed editors. */
import { useEffect, useRef } from "react";

import { ContextDocumentHost, type EditableContextTab } from "./ContextDocumentHost";

/** Concurrent-mount cap. The active tab is always counted; the remaining
 *  slots hold the LRU "warm" editors so a switch back stays instant. */
export const MAX_MOUNTED_EDITORS = 6;

export type ContextEditorMountHostProps = {
  projectId: string;
  /** TRACKED tabs only — viewer tabs are routed elsewhere. */
  trackedTabs: EditableContextTab[];
  /** The currently visible tab id. Must reference a tab in `trackedTabs`. */
  activeTabId: string | null;
  /** Whether the context destination is currently visible. */
  active: boolean;
  readOnly?: boolean;
  onUntitledBecameNonEmpty?: (documentId: string) => Promise<void>;
};

export function pickMountedIds(
  lru: readonly string[],
  trackedIds: readonly string[],
  activeTabId: string | null,
  cap: number,
): Set<string> {
  const known = new Set(trackedIds);
  const out = new Set<string>();
  if (activeTabId && known.has(activeTabId)) out.add(activeTabId);
  for (const id of lru) {
    if (out.size >= cap) break;
    if (known.has(id)) out.add(id);
  }
  return out;
}

export function ContextEditorMountHost({
  projectId,
  trackedTabs,
  activeTabId,
  active,
  onUntitledBecameNonEmpty,
  readOnly = false,
}: ContextEditorMountHostProps) {
  // LRU stack of documentIds: head = most recent. Maintained in an effect so
  // we never mutate state during render. The eviction policy reads from this
  // every render to pick which tabs stay mounted.
  const lruRef = useRef<string[]>([]);

  // Bring the active tab to the front of the LRU stack whenever it changes.
  useEffect(() => {
    if (!activeTabId) return;
    const next = [activeTabId, ...lruRef.current.filter((id) => id !== activeTabId)];
    lruRef.current = next;
  }, [activeTabId]);

  // Drop ids for tabs that no longer exist so the LRU stack can't grow
  // unbounded across long sessions. We key the effect on a stringified id
  // list so we re-run when the membership actually changes, not on every
  // parent render (the array identity is fresh each time).
  const trackedIds = trackedTabs.map((t) => t.documentId);
  const trackedIdsKey = trackedIds.join("|");
  useEffect(() => {
    const known = new Set(trackedIds);
    lruRef.current = lruRef.current.filter((id) => known.has(id));
  }, [trackedIdsKey]);

  const mounted = pickMountedIds(lruRef.current, trackedIds, activeTabId, MAX_MOUNTED_EDITORS);

  return (
    <div className="relative min-h-0 flex-1">
      {trackedTabs.map((tab) => (
        <ContextDocumentHost
          container="editor"
          key={tab.tabInstanceId ?? tab.documentId}
          projectId={projectId}
          tab={tab}
          mountEditor={mounted.has(tab.documentId)}
          shown={tab.documentId === activeTabId}
          active={active}
          readOnly={readOnly}
          onUntitledBecameNonEmpty={onUntitledBecameNonEmpty}
        />
      ))}
    </div>
  );
}
