/**
 * useWriteModeSync — a switch divider that arrives after history loaded is a
 * switch that just applied (from this tab, another tab, or a model-free
 * client): bring the cached chat to its mode and refresh its Work's default.
 *
 * History present when the chat first settles only seeds what is known.
 */
import type { Turn } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { applyWriteModeDivider } from "@/client/query/write-mode-cache";
import { latestWriteModeSwitch } from "./write-mode-model";

export function useWriteModeSync(input: {
  projectId: string;
  threadId: string;
  turns: readonly Turn[];
  /** The chat's history is in the transcript: what is there now is not news. */
  settled: boolean;
}) {
  const { projectId, threadId, turns, settled } = input;
  const queryClient = useQueryClient();
  /** `undefined` until history settles; then the newest divider seen, or null. */
  const seen = useRef<string | null | undefined>(undefined);
  const latest = latestWriteModeSwitch(turns);
  const latestId = latest?.turn.id ?? null;
  const latestMode = latest?.mode ?? null;
  useEffect(() => {
    if (!settled) return;
    if (seen.current === undefined) {
      seen.current = latestId;
      return;
    }
    if (latestId === seen.current) return;
    seen.current = latestId;
    if (latestMode) {
      applyWriteModeDivider(queryClient, { projectId, threadId, mode: latestMode });
    }
  }, [latestId, latestMode, projectId, queryClient, settled, threadId]);
}
