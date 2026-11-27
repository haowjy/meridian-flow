import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useAccountId } from "@/client/account/account-context";
import { useCommandDriver, useCommands } from "@/client/commands/driver-context";
import { submitCommand } from "@/client/commands/submit";
import {
  PROJECT_CREATE_KIND,
  type ProjectCreateBody,
  pendingProject,
  projectCreationFor,
  projectLane,
} from "./project-commands";
import { projectQueryKeys } from "./project-query-keys";

export { readPendingProjectCreation } from "./project-commands";

export function useCreateProject() {
  const userId = useAccountId();
  const driver = useCommandDriver();
  const client = useQueryClient();
  const router = useRouter();

  const submitting = useRef<Promise<string | null> | null>(null);
  const create = useCallback(
    (input: { title: string }): Promise<string | null> => {
      const title = input.title.trim();
      if (!title) return Promise.reject(new Error("Project title is required"));
      if (!driver) return Promise.reject(new Error("Commands are not available yet"));
      if (submitting.current) return submitting.current;
      const id = crypto.randomUUID();
      const body: ProjectCreateBody = { id, title, userId };
      const submit = submitCommand(driver, {
        kind: PROJECT_CREATE_KIND,
        lanes: [projectLane(id)],
        body,
      }).then((record) => {
        if (!record) return null;
        client.setQueryData(projectQueryKeys.detail(id), pendingProject(body));
        void router.navigate({
          to: "/p/$projectId/$",
          params: { projectId: id, _splat: "chats" },
          replace: true,
        });
        return id;
      });
      submitting.current = submit;
      const release = () => {
        submitting.current = null;
      };
      submit.then((id) => id === null && release(), release);
      return submit;
    },
    [client, driver, router, userId],
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

export function useProjectCreationState(projectId: string): ProjectCreationState {
  const driver = useCommandDriver();
  const client = useQueryClient();
  const records = useCommands({ kind: PROJECT_CREATE_KIND });
  const userId = useAccountId();
  const creation = projectCreationFor(records, projectId);

  const retry = useCallback(() => {
    if (driver && creation?.state === "never") void driver.retry(creation.recordId);
  }, [driver, creation]);
  const discard = useCallback(() => {
    if (!driver || creation?.state !== "never") return;
    client.removeQueries({ queryKey: projectQueryKeys.detail(projectId), exact: true });
    void driver.dismiss(creation.recordId);
  }, [client, driver, creation, projectId]);

  if (!creation) return { status: "none", project: null, error: null, retry, discard };
  return {
    status: { sending: "pending", never: "failed", done: "confirmed" }[creation.state] as
      | "pending"
      | "failed"
      | "confirmed",
    project: creation.project ?? pendingProject({ id: projectId, title: creation.title, userId }),
    error:
      creation.state === "never" ? new Error(creation.code ?? "Project creation failed") : null,
    retry,
    discard,
  };
}

export function useSettleConfirmedCreation(projectId: string, hasRouteData: boolean): void {
  const driver = useCommandDriver();
  const router = useRouter();
  const records = useCommands({ kind: PROJECT_CREATE_KIND });
  const confirmed = projectCreationFor(records, projectId)?.state === "done";
  useEffect(() => {
    if (!confirmed || !driver) return;
    if (!hasRouteData) {
      void router.invalidate();
      return;
    }
    void driver.observe(
      (record) =>
        record.kind === PROJECT_CREATE_KIND &&
        (record.body as ProjectCreateBody).id === projectId &&
        record.state === "done",
    );
  }, [confirmed, driver, hasRouteData, projectId, router]);
}

/**
 * For imperative reads (`fetchQuery` ignores `enabled`); query hooks use
 * `projectReadEnabled` instead.
 */
export function useIsProjectPendingCreation(projectId: string | null | undefined): boolean {
  const records = useCommands({ kind: PROJECT_CREATE_KIND });
  const state = projectId ? projectCreationFor(records, projectId)?.state : undefined;
  return state === "sending" || state === "never";
}
