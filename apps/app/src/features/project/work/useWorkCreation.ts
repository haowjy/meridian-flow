/**
 * Navigate-first Work creation: the `create` Work command's record puts the
 * Work in place at once, so the dialog opens it before the POST settles.
 */

import { newDraftId } from "@meridian/contracts";
import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { useCallback } from "react";

import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-mutations";

type CreateWorkInput = Omit<CreateWorkRequest, "id" | "draftId">;

/**
 * Create puts the Work in place and resolves to its id once the command is saved, so a
 * destination only opens on a Work that has a record; the POST follows. `null`: the device
 * could not save it, and the writer was told.
 */
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

/** Retry or discard a refused creation; the `creating` state carries its name and phase. */
export function useWorkCreationRecovery(
  projectId: string,
  workId: string | null,
  /** Where a discarded creation goes: back to the list. */
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
