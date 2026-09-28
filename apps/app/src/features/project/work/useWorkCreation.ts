/** Navigate-first Work creation commands and destination-owned retry state. */

import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest, Work } from "@meridian/contracts/works";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { createProjectWork, listProjectWorks } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  createWorkWithRecovery,
  readWorkCreations,
  removeWorkCreation,
  type WorkCreationRecord,
  writeWorkCreation,
} from "@/client/query/work-creation-cache";
import { convergeWorkProjection } from "@/client/query/work-projection-cache";
import { repairWorksSnapshot } from "@/client/query/works-projection-acquisition";
import { useAccountEpochSignal } from "../context/account-feature-context";
import type { ProjectRouteCommands } from "../routing/project-route";

type CreateWorkInput = Omit<CreateWorkRequest, "id">;
type CreateWorkVariables = {
  workId: string;
  request: CreateWorkRequest & { id: string };
};

function createWorkMutationOptions(
  projectId: string,
  client: ReturnType<typeof useQueryClient>,
  accountSignal: AbortSignal,
) {
  return {
    mutationKey: projectQueryKeys.workCreate(projectId),
    mutationFn: ({ request }: CreateWorkVariables) =>
      createWorkWithRecovery(
        request,
        (body) => createProjectWork(projectId, body, { signal: accountSignal }),
        () => listProjectWorks(projectId, { signal: accountSignal }),
      ),
    onSuccess: (work: Work, variables: CreateWorkVariables) => {
      if (accountSignal.aborted) {
        const current = readWorkCreations(client, projectId)[variables.workId];
        if (current?.accountSignal === accountSignal) {
          removeWorkCreation(client, projectId, variables.workId);
          void client.invalidateQueries({
            queryKey: projectQueryKeys.works(projectId),
            refetchType: "none",
          });
        }
        return;
      }
      const current = readWorkCreations(client, projectId)[variables.workId];
      if (current?.accountSignal !== accountSignal) return;
      writeWorkCreation(client, projectId, {
        workId: variables.workId,
        projectId,
        request: variables.request,
        work,
        accountSignal,
        status: "confirmed",
        error: null,
      });
      convergeWorkProjection(client, { kind: "entity", projectId, operation: "create" });
      void repairWorksSnapshot(client, projectId);
    },
    onError: (error: Error, variables: CreateWorkVariables) => {
      const current = readWorkCreations(client, projectId)[variables.workId];
      if (accountSignal.aborted) {
        if (current?.accountSignal === accountSignal) {
          removeWorkCreation(client, projectId, variables.workId);
        }
        return;
      }
      if (current?.accountSignal !== accountSignal) return;
      writeWorkCreation(client, projectId, {
        workId: variables.workId,
        projectId,
        request: variables.request,
        work: current?.work ?? null,
        accountSignal,
        status: "failed",
        error: error.message,
      });
    },
  };
}

function useWorkCreateMutation(projectId: string, accountSignal: AbortSignal) {
  const client = useQueryClient();
  return useMutation<Work, Error, CreateWorkVariables>(
    createWorkMutationOptions(projectId, client, accountSignal),
  );
}

/** Create inserts the pending entry and opens its UUID route before dispatching POST. */
export function useCreateWork(projectId: string, routeCommands: ProjectRouteCommands) {
  const accountSignal = useAccountEpochSignal();
  const client = useQueryClient();
  const mutation = useWorkCreateMutation(projectId, accountSignal);

  const create = useCallback(
    (input: CreateWorkInput): string => {
      const name = input.name.trim();
      if (!name) throw new Error("Work name is required");
      const workId = parseRequestId(crypto.randomUUID());
      if (!workId) throw new Error("Could not create Work identity");
      const request: CreateWorkRequest & { id: string } = {
        ...input,
        name,
        id: workId,
      };
      writeWorkCreation(client, projectId, {
        workId,
        projectId,
        request,
        work: null,
        accountSignal,
        status: "pending",
        error: null,
      });
      // Created from the works/new dialog: Back returns to the collection.
      void routeCommands.openWork({ kind: "work-detail", workId }, { replace: true });
      mutation.mutate({ workId, request });
      return workId;
    },
    [accountSignal, client, mutation, projectId, routeCommands],
  );

  return { create };
}

export type WorkCreationState = {
  status: "none" | "pending" | "failed" | "confirmed";
  isPending: boolean;
  name: string | null;
  goal: string | null;
  error: Error | null;
  retry: () => void;
  discard: () => void;
};

export function useWorkCreationState(
  projectId: string,
  workId: string | null,
  routeCommands: ProjectRouteCommands,
): WorkCreationState {
  const accountSignal = useAccountEpochSignal();
  const client = useQueryClient();
  const mutation = useWorkCreateMutation(projectId, accountSignal);
  const query = useQuery<Record<string, WorkCreationRecord>>({
    queryKey: projectQueryKeys.workCreations(projectId),
    queryFn: async () => ({}),
    enabled: false,
  });
  const record =
    workId && query.data?.[workId]?.accountSignal === accountSignal
      ? query.data[workId]
      : undefined;
  useEffect(() => {
    for (const stale of Object.values(query.data ?? {})) {
      if (stale.accountSignal === accountSignal) continue;
      if (
        readWorkCreations(client, projectId)[stale.workId]?.accountSignal === stale.accountSignal
      ) {
        removeWorkCreation(client, projectId, stale.workId);
      }
    }
  }, [accountSignal, client, projectId, query.data]);

  const retry = useCallback(() => {
    if (record?.status !== "failed") return;
    writeWorkCreation(client, projectId, { ...record, status: "pending", error: null });
    mutation.mutate({
      workId: record.workId,
      request: record.request,
    });
  }, [client, mutation, projectId, record]);
  const discard = useCallback(() => {
    if (record?.status !== "failed") return;
    removeWorkCreation(client, projectId, record.workId);
    void routeCommands.closeWork({ replace: true });
  }, [client, projectId, record, routeCommands]);

  return {
    status: record?.status ?? "none",
    isPending: record?.status === "pending",
    name: record?.request.name ?? null,
    goal: record?.request.goal ?? null,
    error: record?.error ? new Error(record.error) : null,
    retry,
    discard,
  };
}

export function useWorkCreationRecords(projectId: string): WorkCreationRecord[] {
  const accountSignal = useAccountEpochSignal();
  const query = useQuery<Record<string, WorkCreationRecord>>({
    queryKey: projectQueryKeys.workCreations(projectId),
    queryFn: async () => ({}),
    enabled: false,
  });
  return Object.values(query.data ?? {}).filter((record) => record.accountSignal === accountSignal);
}
