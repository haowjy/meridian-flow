/** Thread-mounted trail subscription; unlike the run controller it remains after RUN_FINISHED. */
import { EventType } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyTrailShellTransition,
  emptyTrailShellState,
  listChangeTrailShells,
  reconcileTrailShells,
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
          return applyTrailShellTransition(current, {
            ...value,
            kind: event.name.endsWith("settled") ? "settled" : "updated",
          });
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
