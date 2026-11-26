import { newDraftId } from "@meridian/contracts";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { useCallback } from "react";

import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-mutations";

type CreateWorkInput = Omit<CreateWorkRequest, "id" | "draftId">;

export function useCreateWork(projectId: string) {
  const { create: createCommand } = useWorkMutations(projectId);
  const create = useCallback(
    (input: CreateWorkInput): Promise<string | null> => {
      const name = input.name.trim();
      if (!name) throw new Error("Work name is required");
      const workId = parseRequestId(crypto.randomUUID());
      if (!workId) throw new Error("Could not create Work identity");
      return new Promise((resolve) => {
        void createCommand(
          { workId, draftId: newDraftId(), name, goal: input.goal },
          { saved: () => resolve(workId) },
        ).then(() => resolve(null));
      });
    },
    [createCommand],
  );
  return { create };
}

const CREATE_OPERATIONS = ["create"] as const;

export function useWorkCreationRecovery(
  projectId: string,
  workId: string | null,
  onDiscarded: () => void,
) {
  const failure = useWorkCommandFailures(projectId, CREATE_OPERATIONS).get(workId ?? "");
  const retry = useCallback(() => void failure?.retry(), [failure]);
  const retryable = failure?.error.retryable ?? true;
  const discard = useCallback(() => {
    if (!failure) return;
    failure.dismiss();
    onDiscarded();
  }, [failure, onDiscarded]);
  return { retry, retryable, discard };
}
