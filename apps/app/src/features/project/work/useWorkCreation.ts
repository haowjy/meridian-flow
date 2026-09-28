/** Navigate-first Work creation commands over the shared creation registry. */

import { parseRequestId } from "@meridian/contracts/request-id";
import type { CreateWorkRequest, Work } from "@meridian/contracts/works";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { createProjectWork, listProjectWorks } from "@/client/api/projects-api";
import {
  type CreationRecord,
  createWithRecovery,
  creationRecordKey,
  readCreationRecord,
  removeCreationRecord,
  useCreationRecord,
  useCreationRecords,
  writeCreationRecord,
} from "@/client/creation/creation-registry";
import { convergeWorkProjection } from "@/client/query/work-projection-cache";
import { repairWorksSnapshot } from "@/client/query/works-projection-acquisition";
import { useAccountEpochSignal, useAccountId } from "../context/account-feature-context";
import type { ProjectRouteCommands } from "../routing/project-route";

type CreateWorkInput = Omit<CreateWorkRequest, "id">;
type WorkCreationPayload = {
  workId: string;
  projectId: string;
  request: CreateWorkRequest & { id: string };
};
export type WorkCreationRecord = CreationRecord<WorkCreationPayload, Work> &
  WorkCreationPayload & { work: Work | null };
type CreateWorkVariables = WorkCreationPayload;

function workCreationKey(workId: string): string {
  return creationRecordKey("work", workId);
}

function workCreationView(record: CreationRecord<WorkCreationPayload, Work>): WorkCreationRecord {
  return { ...record, ...record.payload, work: record.result };
}

function createWorkMutationOptions(
  projectId: string,
  client: ReturnType<typeof useQueryClient>,
  accountId: string,
  accountSignal: AbortSignal,
) {
  return {
    mutationKey: ["projects", projectId, "work-create"],
    mutationFn: ({ request }: CreateWorkVariables) =>
      createWithRecovery(
        () => createProjectWork(projectId, request, { signal: accountSignal }),
        async () =>
          (await listProjectWorks(projectId, { signal: accountSignal })).works.find(
            (work) => work.id === request.id,
          ) ?? null,
      ),
    onSuccess: (work: Work, variables: CreateWorkVariables) => {
      const record = readCreationRecord<WorkCreationPayload, Work>(
        workCreationKey(variables.workId),
        accountId,
      );
      if (!record) return;
      writeCreationRecord(accountId, {
        ...record,
        result: work,
        status: "confirmed",
        error: null,
      });
      convergeWorkProjection(client, { kind: "entity", projectId, operation: "create" });
      void repairWorksSnapshot(client, projectId);
    },
    onError: (error: Error, variables: CreateWorkVariables) => {
      const record = readCreationRecord<WorkCreationPayload, Work>(
        workCreationKey(variables.workId),
        accountId,
      );
      if (!record) return;
      writeCreationRecord(accountId, { ...record, status: "failed", error: error.message });
    },
  };
}

function useWorkCreateMutation(projectId: string, accountId: string, accountSignal: AbortSignal) {
  const client = useQueryClient();
  return useMutation<Work, Error, CreateWorkVariables>(
    createWorkMutationOptions(projectId, client, accountId, accountSignal),
  );
}

/** Create inserts the pending entry and opens its UUID route before dispatching POST. */
export function useCreateWork(projectId: string, routeCommands: ProjectRouteCommands) {
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const mutation = useWorkCreateMutation(projectId, accountId, accountSignal);

  const create = useCallback(
    (input: CreateWorkInput): string => {
      const name = input.name.trim();
      if (!name) throw new Error("Work name is required");
      const workId = parseRequestId(crypto.randomUUID());
      if (!workId) throw new Error("Could not create Work identity");
      const payload: WorkCreationPayload = {
        workId,
        projectId,
        request: { ...input, name, id: workId },
      };
      writeCreationRecord(accountId, {
        key: workCreationKey(workId),
        payload,
        result: null,
        status: "pending",
        error: null,
      });
      // Created from the works/new dialog: Back returns to the collection.
      void routeCommands.openWork({ kind: "work-detail", workId }, { replace: true });
      mutation.mutate(payload);
      return workId;
    },
    [accountId, mutation, projectId, routeCommands],
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
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const mutation = useWorkCreateMutation(projectId, accountId, accountSignal);
  const record = useCreationRecord<WorkCreationPayload, Work>(
    accountId,
    workId ? workCreationKey(workId) : "",
  );

  const retry = useCallback(() => {
    if (record?.status !== "failed") return;
    writeCreationRecord(accountId, { ...record, status: "pending", error: null });
    mutation.mutate(record.payload);
  }, [accountId, mutation, record]);
  const discard = useCallback(() => {
    if (record?.status !== "failed") return;
    removeCreationRecord(record.key, accountId);
    void routeCommands.closeWork({ replace: true });
  }, [accountId, record, routeCommands]);

  return {
    status: record?.status ?? "none",
    isPending: record?.status === "pending",
    name: record?.payload.request.name ?? null,
    goal: record?.payload.request.goal ?? null,
    error: record?.error ? new Error(record.error) : null,
    retry,
    discard,
  };
}

/** Client-side creation projection consumed by the Work route and collection. */
export function useWorkCreationRecords(projectId: string): WorkCreationRecord[] {
  const accountId = useAccountId();
  const records = useCreationRecords(accountId);
  return useMemo(
    () =>
      Object.values(records)
        .filter((record) => record.key.startsWith("work:"))
        .map((record) => record as CreationRecord<WorkCreationPayload, Work>)
        .filter((record) => record.payload.projectId === projectId)
        .map(workCreationView),
    [projectId, records],
  );
}
