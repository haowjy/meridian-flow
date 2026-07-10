/** Thread-mounted trail subscription; unlike the run controller it remains after RUN_FINISHED. */
import { EventType } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useState } from "react";
import {
  type ChangeTrailShell,
  emptyTrailShellState,
  listChangeTrailShells,
  reconcileTrailShells,
  upsertTrailShell,
} from "@/client/change-trails";
import { useThreadTransport } from "@/client/providers/TransportProvider";

type TrailEventValue = {
  threadId: string;
  trailId: string;
  turnId: string | null;
  version: number;
  counts?: { changes: number; swept: number; documents: number };
};

export function useThreadChangeTrails(threadId: string) {
  const transport = useThreadTransport();
  const [state, setState] = useState(emptyTrailShellState);
  const reconcile = useCallback(async () => {
    const shells = await listChangeTrailShells(threadId);
    setState((current) => reconcileTrailShells(current, shells));
  }, [threadId]);

  useEffect(() => {
    setState(emptyTrailShellState());
    void reconcile();
    return transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        if (
          event.type !== EventType.CUSTOM ||
          (event.name !== "meridian.turn_change_trail.updated" &&
            event.name !== "meridian.turn_change_trail.settled")
        )
          return;
        const value = event.value as TrailEventValue;
        if (!value || value.threadId !== threadId || typeof value.version !== "number") return;
        setState((current) => {
          const prior = current.byId[value.trailId];
          const counts =
            value.counts ??
            (prior
              ? {
                  changes: prior.changeCount,
                  swept: prior.sweptChangeCount,
                  documents: prior.documentCount,
                }
              : null);
          if (!counts) return current;
          const shell: ChangeTrailShell = {
            trailId: value.trailId,
            owner: value.turnId
              ? { kind: "turn", threadId, turnId: value.turnId }
              : { kind: "shared", threadId, turnId: null },
            state: event.name.endsWith("settled") ? "settled" : (prior?.state ?? "building"),
            version: value.version,
            changeCount: counts.changes,
            sweptChangeCount: counts.swept,
            documentCount: counts.documents,
            updatedAt: new Date().toISOString(),
            settledAt: event.name.endsWith("settled") ? new Date().toISOString() : null,
          };
          return upsertTrailShell(current, shell);
        });
      },
      onGap: () => {
        setState((current) => ({ ...current, gapPending: true }));
        void reconcile();
      },
    });
  }, [reconcile, threadId, transport]);
  return state;
}
