/** Thread-mounted trail subscription; unlike the run controller it remains after RUN_FINISHED. */
import { EventType } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const queryClient = useQueryClient();
  const [state, setState] = useState(emptyTrailShellState);
  const epoch = useRef(0);
  const reconciled = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcile = useCallback(
    async (requestEpoch: number) => {
      try {
        const shells = await listChangeTrailShells(threadId);
        if (epoch.current !== requestEpoch) return;
        setState((current) => reconcileTrailShells(current, shells));
        reconciled.current = true;
      } catch {
        if (epoch.current !== requestEpoch) return;
        retryTimer.current = setTimeout(() => void reconcile(requestEpoch), 1_000);
      }
    },
    [threadId],
  );

  useEffect(() => {
    setState(emptyTrailShellState());
    reconciled.current = false;
    const threadEpoch = ++epoch.current;
    void queryClient.removeQueries({ queryKey: ["change-trail-detail", threadId] });
    void reconcile(threadEpoch);
    const unsubscribe = transport.subscribe(threadId, {
      onEvent: ({ event }) => {
        if (
          event.type !== EventType.CUSTOM ||
          (event.name !== "meridian.turn_change_trail.updated" &&
            event.name !== "meridian.turn_change_trail.settled")
        )
          return;
        const value = event.value as TrailEventValue;
        if (!value || value.threadId !== threadId || typeof value.version !== "number") return;
        if (!reconciled.current) {
          const eventEpoch = ++epoch.current;
          void reconcile(eventEpoch);
        }
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
        const gapEpoch = ++epoch.current;
        reconciled.current = false;
        setState((current) => ({ ...current, gapPending: true }));
        void queryClient.removeQueries({ queryKey: ["change-trail-detail", threadId] });
        void reconcile(gapEpoch);
      },
    });
    return () => {
      epoch.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      unsubscribe();
      void queryClient.removeQueries({ queryKey: ["change-trail-detail", threadId] });
    };
  }, [queryClient, reconcile, threadId, transport]);
  return state;
}
