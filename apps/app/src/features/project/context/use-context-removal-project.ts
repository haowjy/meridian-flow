/** React subscription adapter for the framework-independent removal coordinator. */
import { useSyncExternalStore } from "react";
import {
  type ContextRemovalProjectSnapshot,
  contextRemovalCoordinator,
} from "./context-removal-coordinator";

const EMPTY_SNAPSHOT: ContextRemovalProjectSnapshot = {
  selection: { status: "none", revision: 0 },
  rememberedRoute: null,
  autoOpenBlock: null,
};

export function useContextRemovalProject(projectId: string): ContextRemovalProjectSnapshot {
  return useSyncExternalStore(
    (listener) => contextRemovalCoordinator.subscribe(projectId, listener),
    () => contextRemovalCoordinator.getProjectSnapshot(projectId),
    () => EMPTY_SNAPSHOT,
  );
}
