/** Navigate-first project creation and destination-owned recovery state. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { CreateProjectRequest } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { createProject, getProject } from "@/client/api/projects-api";
import {
  type CreationRecord,
  createWithRecovery,
  creationRecordKey,
  readCreationRecord,
  removeCreationRecord,
  useCreationRecord,
  useCurrentCreationRecord,
  writeCreationRecord,
} from "@/client/creation/creation-registry";
import { useProjectActions } from "@/client/stores";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { projectQueryKeys } from "./project-query-keys";

type ProjectCreationPayload = { id: string; title: string; userId: string };
export type ProjectCreationRecord = CreationRecord<ProjectCreationPayload, Project>;
type CreateProjectVariables = ProjectCreationPayload;

function projectCreationKey(projectId: string): string {
  return creationRecordKey("project", projectId);
}

function pendingProject(
  id: string,
  title: string,
  userId: string,
  now = new Date().toISOString(),
): Project {
  return {
    id,
    userId,
    title,
    slug: "",
    description: null,
    settings: {},
    isPersonal: false,
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

/** Loader short-circuit authority; browser history state is never creation state. */
export function readPendingProjectCreation(projectId: string): ProjectCreationRecord | undefined {
  const record = readCreationRecord<ProjectCreationPayload, Project>(projectCreationKey(projectId));
  return record?.status === "pending" || record?.status === "failed" ? record : undefined;
}

function useProjectCreationMutation(userId: string, accountSignal: AbortSignal) {
  const client = useQueryClient();
  const { ensureProject } = useProjectActions();
  const router = useRouter();

  return useMutation<Project, Error, CreateProjectVariables>({
    mutationKey: ["projects", "create"],
    mutationFn: ({ id, title }) =>
      createWithRecovery(
        () =>
          createProject({ id, title } satisfies CreateProjectRequest, { signal: accountSignal }),
        async () => getProject(id, { signal: accountSignal }),
      ),
    onSuccess: (project, variables) => {
      const record = readCreationRecord<ProjectCreationPayload, Project>(
        projectCreationKey(variables.id),
        userId,
      );
      if (!record) return;
      ensureProject(project);
      client.setQueryData(projectQueryKeys.detail(project.id), project);
      writeCreationRecord(userId, {
        ...record,
        status: "confirmed",
        result: project,
        error: null,
      });
      void router.invalidate();
    },
    onError: (error, variables) => {
      const record = readCreationRecord<ProjectCreationPayload, Project>(
        projectCreationKey(variables.id),
        userId,
      );
      if (record)
        writeCreationRecord(userId, { ...record, status: "failed", error: error.message });
    },
  });
}

/** The create command inserts, navigates, then dispatches without waiting for the server. */
export function useCreateProject(userId: string, accountSignal: AbortSignal) {
  const client = useQueryClient();
  const router = useRouter();
  const mutation = useProjectCreationMutation(userId, accountSignal);

  const create = useCallback(
    (input: { title: string }): string => {
      const title = input.title.trim();
      if (!title) throw new Error("Project title is required");
      const id = crypto.randomUUID();
      const payload = { id, title, userId };
      writeCreationRecord(userId, {
        key: projectCreationKey(id),
        payload,
        result: null,
        status: "pending",
        error: null,
      });
      client.setQueryData(projectQueryKeys.detail(id), pendingProject(id, title, userId));
      void router.navigate({
        to: "/p/$projectId/$",
        params: { projectId: id, _splat: "works" },
        // Created from the /projects/new dialog: Back returns to the library.
        replace: true,
      });
      mutation.mutate(payload);
      return id;
    },
    [client, mutation, router, userId],
  );

  return { create };
}

export type ProjectCreationState = {
  status: "none" | "pending" | "failed" | "confirmed";
  project: Project | null;
  error: Error | null;
  retry: () => void;
  discard: () => void;
};

export function useProjectCreationState(
  projectId: string,
  accountSignal: AbortSignal,
): ProjectCreationState {
  const accountId = useAccountId();
  const client = useQueryClient();
  const mutation = useProjectCreationMutation(accountId, accountSignal);
  const record = useCreationRecord<ProjectCreationPayload, Project>(
    accountId,
    projectCreationKey(projectId),
  );

  const retry = useCallback(() => {
    if (record?.status !== "failed") return;
    writeCreationRecord(accountId, { ...record, status: "pending", error: null });
    mutation.mutate(record.payload);
  }, [accountId, mutation, record]);
  const discard = useCallback(() => {
    if (!record || (record.status !== "failed" && record.status !== "pending")) return;
    client.removeQueries({ queryKey: projectQueryKeys.detail(projectId), exact: true });
    removeCreationRecord(projectCreationKey(projectId), accountId);
  }, [accountId, client, projectId, record]);

  return {
    status: record?.status ?? "none",
    project: record
      ? (record.result ??
        pendingProject(record.payload.id, record.payload.title, record.payload.userId))
      : null,
    error: record?.error ? new Error(record.error) : null,
    retry,
    discard,
  };
}

/** Dependent project reads pause for unresolved or failed creates. */
export function useIsProjectPendingCreation(projectId: string | null | undefined): boolean {
  const record = useCurrentCreationRecord<ProjectCreationPayload, Project>(
    projectId ? projectCreationKey(projectId) : "",
  );
  return record?.status === "pending" || record?.status === "failed";
}
