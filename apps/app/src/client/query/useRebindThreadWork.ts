/** HTTP mutation and causal outcome classification for a thread Work rebind. */
import type { RebindThreadWorkResponse, Work } from "@meridian/contracts/works";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isMeridianApiError } from "@/client/api/http-client";
import { rebindThreadWork } from "@/client/api/threads-api";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import {
  convergeThreadWorkBinding,
  readStableThreadWorkBinding,
  type ThreadWorkProjectionCursor,
} from "./thread-work-binding-cache";

export type ThreadWorkMutationInput =
  | {
      target: { kind: "none" } | { kind: "work"; workId: string };
      previousWorkId: string | null;
    }
  | { targetWorkId: string; previousWorkId: string };

export type NormalizedCommit = {
  threadId: string;
  work: Work | null;
  changed: boolean;
};

export type ThreadWorkMutationOutcome =
  | { kind: "confirmed"; result: NormalizedCommit; response: RebindThreadWorkResponse }
  | { kind: "reconciled_committed"; result: NormalizedCommit & { changed: true } }
  | { kind: "reconciled_not_current"; requestedWorkId: string | null; currentWork: Work | null }
  | { kind: "superseded"; requestedWorkId: string | null; currentWork: Work | null };

export function useRebindThreadWork(projectId: string, threadId: string) {
  const client = useQueryClient();
  return useMutation<ThreadWorkMutationOutcome, unknown, ThreadWorkMutationInput>({
    mutationFn: async (input) => {
      const target =
        "target" in input ? input.target : { kind: "work" as const, workId: input.targetWorkId };
      const targetWorkId = target.kind === "work" ? target.workId : null;
      const { previousWorkId } = input;
      const cursorKey = threadQueryKeys.workProjectionCursor(threadId);
      const admitted = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      let response: RebindThreadWorkResponse | null = null;
      try {
        response = await rebindThreadWork(threadId, {
          target,
        });
      } catch (cause) {
        if (isMeridianApiError(cause)) throw cause;
      }
      const settled = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      const overlapped = admitted !== settled;
      if (response && !overlapped) {
        convergeThreadWorkBinding(client, { source: "confirmed", projectId, result: response });
        const work = targetWorkId
          ? (client
              .getQueryData<import("@meridian/contracts/protocol").ListWorksResponse>(
                projectQueryKeys.works(projectId),
              )
              ?.works.find(({ id }) => id === targetWorkId) ?? null)
          : null;
        if (work || targetWorkId === null) {
          return {
            kind: "confirmed",
            result: { threadId: response.threadId, work, changed: response.changed },
            response,
          };
        }
      }

      const fresh = await readStableThreadWorkBinding(client, {
        projectId,
        threadId,
        previousWorkId,
      });
      const currentWork = fresh.catalog.works.find(({ id }) => id === fresh.workId) ?? null;
      if (fresh.workId === targetWorkId) {
        if (response) {
          return {
            kind: "confirmed",
            result: { threadId: response.threadId, work: currentWork, changed: response.changed },
            response,
          };
        }
        return {
          kind: "reconciled_committed",
          result: {
            threadId,
            work: currentWork,
            changed: true,
          },
        };
      }
      return overlapped
        ? { kind: "superseded", requestedWorkId: targetWorkId, currentWork }
        : { kind: "reconciled_not_current", requestedWorkId: targetWorkId, currentWork };
    },
  });
}
