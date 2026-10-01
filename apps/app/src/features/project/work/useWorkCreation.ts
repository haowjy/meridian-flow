/**
 * Navigate-first Work creation: the `create` Work command's record puts the
 * Work in place at once, and its UUID route opens before the POST settles.
 */

import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest } from "@meridian/contracts/works";
import { useCallback } from "react";

import { useWorkCommandFailures } from "@/client/query/work-command-selectors";
import { useWorkMutations } from "@/client/query/work-command-store";
import type { ProjectRouteCommands } from "../routing/project-route";

type CreateWorkInput = Omit<CreateWorkRequest, "id">;

/** Create puts the Work in place and opens its route; the POST follows. */
export function useCreateWork(projectId: string, routeCommands: ProjectRouteCommands) {
  const { create: createCommand } = useWorkMutations(projectId);
  const create = useCallback(
    (input: CreateWorkInput): string => {
      const name = input.name.trim();
      if (!name) throw new Error("Work name is required");
      const workId = parseRequestId(crypto.randomUUID());
      if (!workId) throw new Error("Could not create Work identity");
      void createCommand({ workId, name, goal: input.goal });
      // Created from the works/new dialog: Back returns to the collection.
      void routeCommands.openWork({ kind: "work-detail", workId }, { replace: true });
      return workId;
    },
    [createCommand, routeCommands],
  );
  return { create };
}

const CREATE_OPERATIONS = ["create"] as const;

/** Retry or discard a refused creation; the route's `creating` state carries its name and phase. */
export function useWorkCreationRecovery(
  projectId: string,
  workId: string | null,
  routeCommands: ProjectRouteCommands,
) {
  const failure = useWorkCommandFailures(projectId, CREATE_OPERATIONS).get(workId ?? "");
  const retry = useCallback(() => void failure?.retry(), [failure]);
  const discard = useCallback(() => {
    if (!failure) return;
    failure.dismiss();
    void routeCommands.closeWork({ replace: true });
  }, [failure, routeCommands]);
  return { retry, discard };
}
