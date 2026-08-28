/** React subscription adapter for the framework-independent removal coordinator. */
import { useSyncExternalStore } from "react";
import { useContextRemovalCoordinator } from "./ContextRemovalAccountProvider";
import type { ContextRemovalProjectSnapshot } from "./context-removal-coordinator";

const EMPTY_SNAPSHOT: ContextRemovalProjectSnapshot = {
  selection: { status: "none", revision: 0 },
  admitted: null,
  removalFence: null,
  transitionRevision: 0,
  live: false,
};

export function useContextRemovalProject(projectId: string): ContextRemovalProjectSnapshot {
  const coordinator = useContextRemovalCoordinator();
  return useSyncExternalStore(
    (listener) => coordinator.subscribe(projectId, listener),
    () => coordinator.getProjectSnapshot(projectId),
    () => EMPTY_SNAPSHOT,
  );
}
