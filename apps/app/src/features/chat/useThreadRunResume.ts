/**
 * Attach to the open execution a mounted durable snapshot shows. The controller
 * takes it only while settled: work for an owed message is already followed.
 */
import type { SnapshotLiveState } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";

export function useThreadRunResume(
  threadId: string,
  controller: ThreadRunController,
  snapshot: {
    liveState: SnapshotLiveState | null;
    activateProjection: (after?: string) => boolean;
  },
): void {
  const attached = useRef<string | null>(null);
  useEffect(() => {
    attached.current = null;
    return () => {
      attached.current = null;
    };
  }, [threadId, controller]);
  useEffect(() => {
    const executionId = snapshot.liveState?.openExecutionId ?? null;
    if (!snapshot.liveState || executionId === null) return;
    if (attached.current === executionId || !snapshot.activateProjection()) return;
    attached.current = executionId;
    controller.attach(threadId, {
      executionId,
      after: snapshot.liveState.resumeAfterSeq,
      runningTurnId: snapshot.liveState.runningTurnId,
    });
  }, [threadId, controller, snapshot.liveState, snapshot.activateProjection]);
}
