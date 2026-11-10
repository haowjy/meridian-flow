/** ContextEditorMountHost — hosts the *active* TRACKED context document with a bounded "keep-warm" set of recently-viewed editors. */
import { Fragment, type ReactNode, useEffect, useRef } from "react";

import type { EditableContextTab } from "./ContextDocumentHost";

/** Concurrent-mount cap. The active tab is always counted; the remaining
 *  slots hold the LRU "warm" editors so a switch back stays instant. */
export const MAX_MOUNTED_EDITORS = 6;

export type ContextEditorMountHostProps = {
  /** TRACKED tabs only — viewer tabs are routed elsewhere. */
  trackedTabs: EditableContextTab[];
  /** The currently visible tab id. Must reference a tab in `trackedTabs`. */
  activeTabId: string | null;
  /** One tab's frame: its own review, its chrome while shown, and its editor host. */
  renderTab: (
    tab: EditableContextTab,
    placement: { mountEditor: boolean; shown: boolean },
  ) => ReactNode;
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
  trackedTabs,
  activeTabId,
  renderTab,
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
        <Fragment key={tab.tabInstanceId ?? tab.documentId}>
          {renderTab(tab, {
            mountEditor: mounted.has(tab.documentId),
            shown: tab.documentId === activeTabId,
          })}
        </Fragment>
      ))}
    </div>
  );
}
