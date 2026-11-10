/**
 * Navigate-first Work creation: the `create` Work command's record puts the
 * Work in place at once, so the dialog opens it before the POST settles.
 */

import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { useCallback } from "react";

import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-command-store";

type CreateWorkInput = Omit<CreateWorkRequest, "id">;

/** Create puts the Work in place and returns its id; the POST follows. */
export function useCreateWork(projectId: string) {
  const { create: createCommand } = useWorkMutations(projectId);
  const create = useCallback(
    (input: CreateWorkInput): string => {
      const name = input.name.trim();
      if (!name) throw new Error("Work name is required");
      const workId = parseRequestId(crypto.randomUUID());
      if (!workId) throw new Error("Could not create Work identity");
      void createCommand({ workId, name, goal: input.goal });
      return workId;
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
  const discard = useCallback(() => {
    if (!failure) return;
    failure.dismiss();
    onDiscarded();
  }, [failure, onDiscarded]);
  return { retry, discard };
}
