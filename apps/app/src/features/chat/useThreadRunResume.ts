/** Resume the server's active run from a mounted durable snapshot. */
import type { ThreadLiveState } from "@meridian/contracts/protocol";
import { useEffect, useRef } from "react";
import type { ThreadRunController } from "@/client/copilot/ThreadRunController";

export function activeSnapshotResumeAfterSeq(liveState: ThreadLiveState): string | null {
  if (liveState.runningTurnId === null && liveState.status.kind !== "awake") return null;
  try {
    const after = BigInt(liveState.resumeAfterSeq);
    return after < 0n ? null : after.toString();
  } catch {
    return null;
  }
}

export function useThreadRunResume(
  threadId: string,
  controller: ThreadRunController,
  snapshot: {
    liveState: ThreadLiveState | null;
    activateProjection: (after?: string) => boolean;
  },
): void {
  const resumed = useRef<string | null>(null);
  useEffect(() => {
    resumed.current = null;
    return () => {
      resumed.current = null;
    };
  }, [threadId, controller]);
  useEffect(() => {
    if (!snapshot.liveState) return;
    const after = activeSnapshotResumeAfterSeq(snapshot.liveState);
    if (after === null) return;
    const key = snapshot.liveState.runningTurnId ?? after;
    if (resumed.current === key || !snapshot.activateProjection()) return;
    resumed.current = key;
    controller.resume(threadId, {
      after,
      expectedTurnId: snapshot.liveState.runningTurnId ?? undefined,
    });
  }, [threadId, controller, snapshot.liveState, snapshot.activateProjection]);
}
