/** Persistent owner for a thread's Work-binding subscription: projected signals, receipts and gap resync. */
import { EventType } from "@meridian/contracts/protocol";
import {
  decodeWorkHandle,
  parseWorkReceipt,
  WORK_CONTEXT_PROJECTION_EVENT,
  type WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "@/client/query/thread-work-binding-cache";
import { convergeWorkProjection } from "@/client/query/work-projection-cache";
import { repairWorksSnapshot } from "@/client/query/works-projection-acquisition";
import { useIsThreadPendingCreation } from "@/client/stores";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";

function decodeWorkProjection(
  threadId: string,
  seq: string,
  event: { type: string; name?: string; value?: unknown },
): { seq: string; signal: WorkContextProjectionSignal } | null {
  if (event.type !== EventType.CUSTOM || event.name !== WORK_CONTEXT_PROJECTION_EVENT) return null;
  const value = event.value;
  if (!value || typeof value !== "object") return null;
  const { threadId: eventThreadId, projectId, scope } = value as Record<string, unknown>;
  if (
    eventThreadId !== threadId ||
    typeof projectId !== "string" ||
    !scope ||
    typeof scope !== "object"
  ) {
    return null;
  }
  const parsedScope = scope as Record<string, unknown>;
  if (typeof parsedScope.workId !== "string") return null;
  if (parsedScope.workHandle === null) {
    return {
      seq,
      signal: { threadId, projectId, scope: { workId: parsedScope.workId, workHandle: null } },
    };
  }
  const workHandle = decodeWorkHandle(parsedScope.workHandle);
  return workHandle
    ? {
        seq,
        signal: {
          threadId,
          projectId,
          scope: { workId: parsedScope.workId, workHandle },
        },
      }
    : null;
}

function decodeWorkReceipt(event: { type: string; metadata?: unknown }) {
  if (event.type !== EventType.TOOL_CALL_RESULT) return null;
  const metadata = event.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return parseWorkReceipt((metadata as Record<string, unknown>).workReceipt);
}

export function useThreadWorkProjections({
  threadId,
  projectId,
}: {
  threadId: string;
  projectId: string | null;
}) {
  const transport = useThreadTransport();
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const queryClient = useQueryClient();
  const accountSignal = useOptionalAccountEpochSignal();
  /**
   * Subscription identity, bumped when the thread changes or the hook unmounts.
   * Only responses belonging to the current subscription may commit.
   *
   * Deliberately NOT bumped per trigger: doing that made every trigger cancel
   * the request the previous one started, so a burst of gaps left the binding
   * stale — each response arrived to find its own counter already superseded.
   * Freshness is handled by coalescing below.
   */
  const generation = useRef(0);
  /**
   * The Work-binding resync fetches threads + works and
   * invalidates the thread namespace. A gap burst must not run it per gap, so it
   * coalesces: one in flight, one follow-up.
   */
  const bindingInFlight = useRef(false);
  const bindingAgain = useRef(false);
  const resyncBinding = useCallback(
    async (requestGeneration: number) => {
      if (!projectId || generation.current !== requestGeneration) return;
      if (bindingInFlight.current) {
        bindingAgain.current = true;
        return;
      }
      bindingInFlight.current = true;
      try {
        await readStableThreadWorkBinding(
          queryClient,
          {
            projectId,
            threadId,
            previousWorkId: null,
          },
          accountSignal ?? undefined,
        );
      } catch {
        // Best effort: the next mount, acknowledgment or gap re-runs the resync.
      } finally {
        bindingInFlight.current = false;
      }
      if (generation.current !== requestGeneration) return;
      if (bindingAgain.current) {
        bindingAgain.current = false;
        void resyncBinding(requestGeneration);
      }
    },
    [accountSignal, projectId, queryClient, threadId],
  );

  useEffect(() => {
    if (isPendingCreation) return;
    bindingInFlight.current = false;
    bindingAgain.current = false;
    const threadGeneration = ++generation.current;
    void resyncBinding(threadGeneration);
    const unsubscribe = transport.subscribe(threadId, {
      onLiveState: () => {
        if (accountSignal?.aborted) return;
        // Head subscriptions omit events between the mount reads and acknowledgment.
        void resyncBinding(threadGeneration);
      },
      onEvent: ({ seq, event }) => {
        if (accountSignal?.aborted) return;
        const receipt = decodeWorkReceipt(event);
        if (projectId && receipt?.changed) {
          convergeWorkProjection(queryClient, {
            kind: "entity",
            projectId,
            operation: receipt.operation,
          });
          void repairWorksSnapshot(queryClient, projectId);
        }
        const projection = decodeWorkProjection(threadId, seq, event);
        if (projection) {
          convergeThreadWorkBinding(
            queryClient,
            { source: "projected", ...projection },
            accountSignal ?? undefined,
          );
          return;
        }
      },
      onGap: () => {
        if (accountSignal?.aborted) return;
        void resyncBinding(threadGeneration);
      },
    });
    return () => {
      generation.current += 1;
      unsubscribe();
    };
  }, [
    accountSignal,
    projectId,
    queryClient,
    resyncBinding,
    threadId,
    transport,
    isPendingCreation,
  ]);
}
