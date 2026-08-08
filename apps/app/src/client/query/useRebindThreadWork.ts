/** HTTP mutation and causal outcome classification for a thread Work rebind. */
import type { RebindThreadWorkResponse, Work } from "@meridian/contracts/works";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isMeridianApiError } from "@/client/api/http-client";
import { rebindThreadWork } from "@/client/api/threads-api";
import { threadQueryKeys } from "./thread-query-keys";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
  type ThreadWorkProjectionCursor,
} from "./thread-work-binding-cache";

export type ThreadWorkMutationInput = { targetWorkId: string; previousWorkId: string };

export type NormalizedCommit = {
  threadId: string;
  previousWorkId: string;
  work: Work;
  changed: boolean;
  preferenceChanged: boolean;
  undoWorkId: string | null;
};

export type ThreadWorkMutationOutcome =
  | { kind: "confirmed"; result: RebindThreadWorkResponse; undoWorkId: string | null }
  | { kind: "reconciled_committed"; result: NormalizedCommit & { changed: true } }
  | { kind: "reconciled_not_current"; requestedWorkId: string; currentWork: Work }
  | { kind: "superseded"; requestedWorkId: string; currentWork: Work };

function inverseWorkId(result: RebindThreadWorkResponse): string | null {
  const inverse = result.receipt.inverse;
  return inverse?.command === "switch" ? inverse.workId : null;
}

export function useRebindThreadWork(projectId: string, threadId: string) {
  const client = useQueryClient();
  return useMutation<ThreadWorkMutationOutcome, unknown, ThreadWorkMutationInput>({
    mutationFn: async ({ targetWorkId, previousWorkId }) => {
      const cursorKey = threadQueryKeys.workProjectionCursor(threadId);
      const admitted = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      let response: RebindThreadWorkResponse | null = null;
      try {
        response = await rebindThreadWork(threadId, { workId: targetWorkId });
      } catch (cause) {
        if (isMeridianApiError(cause)) throw cause;
      }
      const settled = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      const overlapped = admitted !== settled;
      if (response && !overlapped) {
        convergeThreadWorkBinding(client, { source: "confirmed", projectId, result: response });
        return { kind: "confirmed", result: response, undoWorkId: inverseWorkId(response) };
      }

      const fresh = await readStableThreadWorkBinding(client, {
        projectId,
        threadId,
        previousWorkId,
      });
      const currentWork = fresh.catalog.works.find(({ id }) => id === fresh.workId);
      if (!currentWork) throw new Error("The thread's current Work is absent from its catalog");
      if (fresh.workId === targetWorkId) {
        if (response) {
          return { kind: "confirmed", result: response, undoWorkId: inverseWorkId(response) };
        }
        return {
          kind: "reconciled_committed",
          result: {
            threadId,
            previousWorkId,
            work: currentWork,
            changed: true,
            preferenceChanged: false,
            undoWorkId: previousWorkId,
          },
        };
      }
      return overlapped
        ? { kind: "superseded", requestedWorkId: targetWorkId, currentWork }
        : { kind: "reconciled_not_current", requestedWorkId: targetWorkId, currentWork };
    },
  });
}
