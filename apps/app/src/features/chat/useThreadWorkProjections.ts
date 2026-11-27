import { EventType } from "@meridian/contracts/protocol";
import {
  decodeWorkHandle,
  parseWorkReceipt,
  WORK_CONTEXT_PROJECTION_EVENT,
  type WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useThreadTransport } from "@/client/providers/TransportProvider";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
} from "@/client/query/thread-work-binding-cache";
import { convergeWorkProjection } from "@/client/query/work-projection-cache";
import { repairWorksSnapshot } from "@/client/query/works-projection-acquisition";
import { useIsThreadPendingCreation } from "@/client/stores";
import { useOptionalAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { singleFlight } from "@/lib/single-flight";

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
  useEffect(() => {
    if (isPendingCreation) return;
    let active = true;
    const resyncBinding = singleFlight(async () => {
      if (!projectId || !active) return;
      try {
        await readStableThreadWorkBinding(
          queryClient,
          { projectId, threadId, previousWorkId: null },
          accountSignal ?? undefined,
        );
      } catch {
        // Best effort: the next acknowledgment or gap re-runs the resync.
      }
    });
    const unsubscribe = transport.subscribe(threadId, {
      onLiveState: () => {
        if (accountSignal?.aborted) return;
        resyncBinding();
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
        }
      },
      onGap: () => {
        if (accountSignal?.aborted) return;
        resyncBinding();
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accountSignal, projectId, queryClient, threadId, transport, isPendingCreation]);
}
