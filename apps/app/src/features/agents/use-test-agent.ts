// @ts-nocheck
/**
 * useTestAgent — Library "Test this agent" action: fresh bound thread in the dock.
 *
 * Creates a new server thread with the chosen agent and routes selection through
 * `onSelectDockThread` so the routing invariant holds (dock never writes `?screen`).
 *
 * TODO(wire-detail-pane): wire into `LibraryDetailPane` when the editor lane
 * exposes its optional callback prop.
 */
import { useCallback } from "react";

import { useCreateBoundWorkbenchThread } from "./use-create-bound-thread";

export type UseTestAgentArgs = {
  workbenchId: string;
  onSelectDockThread: (threadId: string) => void;
};

export function useTestAgent({ workbenchId, onSelectDockThread }: UseTestAgentArgs) {
  const createBound = useCreateBoundWorkbenchThread(workbenchId);

  const testAgent = useCallback(
    (agentSlug: string) => {
      createBound.mutate(
        { agentSlug },
        {
          onSuccess: (thread) => {
            onSelectDockThread(thread.id);
          },
        },
      );
    },
    [createBound, onSelectDockThread],
  );

  return { testAgent, testing: createBound.isPending };
}
