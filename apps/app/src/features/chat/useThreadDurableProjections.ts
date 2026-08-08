/** Persistent owner for durable thread projections, including Work binding and trails. */
import { EventType } from "@meridian/contracts/protocol";
import {
  WORK_CONTEXT_PROJECTION_EVENT,
  type WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyTrailShellTransition,
  emptyTrailShellState,
  listChangeTrailShells,
  reconcileTrailShells,
} from "@/client/change-trails";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "@/client/query/thread-work-binding-cache";

type TrailEventValue = {
  threadId: string;
  trailId: string;
  turnId: string | null;
  version: number;
  counts?: { changes: number; documents: number };
  shell?: {
    counts: { changes: number; documents: number };
    documents: Array<{ documentId: string; title: string }>;
    wordsAdded: number | null;
    wordsRemoved: number | null;
  };
};

function decodeWorkProjection(
  threadId: string,
  seq: string,
  event: { type: string; name?: string; value?: unknown },
): { seq: string; signal: WorkContextProjectionSignal } | null {
  if (event.type !== EventType.CUSTOM || event.name !== WORK_CONTEXT_PROJECTION_EVENT) return null;
  const value = event.value;
  if (!value || typeof value !== "object") return null;
  const { threadId: eventThreadId, projectId, workId } = value as Record<string, unknown>;
  return eventThreadId === threadId && typeof projectId === "string" && typeof workId === "string"
    ? { seq, signal: { threadId, projectId, workId } }
    : null;
}

export function useThreadDurableProjections({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string | null;
}) {
  const transport = useThreadTransport();
  const queryClient = useQueryClient();
  const [state, setState] = useState(emptyTrailShellState);
  /**
   * Subscription identity, bumped when the thread changes or the hook unmounts.
   * Only responses belonging to the current subscription may commit.
   *
   * Deliberately NOT bumped per trigger: doing that made every trigger cancel
   * the request the previous one started, so a burst of gaps or settled events
   * left the list permanently empty — each response arrived to find its own
   * counter already superseded. Freshness is handled by coalescing below.
   */
  const generation = useRef(0);
  const reconciled = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * At most one list request is in flight per generation. Triggers arriving
   * during one ask for a single follow-up instead of racing it, so a burst of N
   * triggers costs two requests rather than N, and every request that starts is
   * allowed to commit. `listChangeTrailShells` returns whole server state, so
   * the follow-up subsumes everything the burst would have asked for.
   */
  const inFlight = useRef(false);
  const again = useRef(false);
  const reconcile = useCallback(
    async (requestGeneration: number) => {
      if (generation.current !== requestGeneration) return;
      if (inFlight.current) {
        again.current = true;
        return;
      }
      inFlight.current = true;
      let failed = false;
      try {
        const shells = await listChangeTrailShells(threadId);
        if (generation.current !== requestGeneration) return;
        setState((current) => reconcileTrailShells(current, shells));
        reconciled.current = true;
      } catch {
        failed = true;
      } finally {
        inFlight.current = false;
      }
      if (generation.current !== requestGeneration) return;
      if (failed) {
        again.current = false;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => void reconcile(requestGeneration), 1_000);
        return;
      }
      if (again.current) {
        again.current = false;
        void reconcile(requestGeneration);
      }
    },
    [threadId],
  );

  useEffect(() => {
    setState(emptyTrailShellState());
    reconciled.current = false;
    inFlight.current = false;
    again.current = false;
    const threadGeneration = ++generation.current;
    void queryClient.removeQueries({ queryKey: ["change-trail-detail", threadId] });
    void reconcile(threadGeneration);
    const unsubscribe = transport.subscribe(threadId, {
      onEvent: ({ seq, event }) => {
        const projection = decodeWorkProjection(threadId, seq, event);
        if (projection) {
          convergeThreadWorkBinding(queryClient, { source: "projected", ...projection });
          return;
        }
        if (
          event.type !== EventType.CUSTOM ||
          (event.name !== "meridian.turn_change_trail.updated" &&
            event.name !== "meridian.turn_change_trail.settled")
        )
          return;
        const value = event.value as TrailEventValue;
        if (!value || value.threadId !== threadId || typeof value.version !== "number") return;
        if (!reconciled.current || event.name.endsWith("settled")) {
          void reconcile(threadGeneration);
        }
        setState((current) => {
          return applyTrailShellTransition(current, {
            ...value,
            kind: event.name.endsWith("settled") ? "settled" : "updated",
          });
        });
      },
      onGap: () => {
        reconciled.current = false;
        setState((current) => (current.gapPending ? current : { ...current, gapPending: true }));
        // Deliberately NOT dropping change-trail detail here. Detail is immutable
        // for a given (trailId, version) and the detail query is keyed by version,
        // so a changed trail refetches on its own once the reconcile below lands.
        // Dropping it per gap destroyed in-flight fetches, and threads whose
        // journal outgrows the server's replay window gap continuously — there,
        // an expanded card's change rows could never finish loading at all.
        void reconcile(threadGeneration);
        if (projectId) {
          void readStableThreadWorkBinding(queryClient, {
            projectId,
            threadId,
            previousWorkId: null,
          }).catch(() => undefined);
        }
      },
    });
    return () => {
      generation.current += 1;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      unsubscribe();
      void queryClient.removeQueries({ queryKey: ["change-trail-detail", threadId] });
    };
  }, [projectId, queryClient, reconcile, threadId, transport]);
  return { changeTrails: state };
}
