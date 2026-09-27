import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  createProjectWithRecovery,
  pendingProject,
  pendingProjectFromRouteState,
  pendingProjectRouteState,
  readProjectCreation,
  removeProjectCreation,
  writeProjectCreation,
} from "./project-creation-cache";
import { projectQueryKeys } from "./project-query-keys";

const PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000";
const ACCOUNT_SIGNAL = new AbortController().signal;

function serverProject(): Project {
  return {
    id: PROJECT_ID,
    userId: "user",
    title: "A new serial",
    slug: "a-new-serial",
    description: null,
    settings: {},
    isPersonal: false,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("project creation cache", () => {
  it("keeps a pending project addressable by its UUID and title", () => {
    const client = new QueryClient();
    const project = pendingProject(PROJECT_ID, "A new serial", "user");
    writeProjectCreation(client, {
      id: PROJECT_ID,
      title: project.title,
      project,
      accountSignal: ACCOUNT_SIGNAL,
      status: "pending",
      error: null,
    });
    const state = pendingProjectRouteState({
      id: PROJECT_ID,
      title: project.title,
      userId: "user",
    });

    expect(readProjectCreation(client, PROJECT_ID)).toMatchObject({ status: "pending" });
    expect(pendingProjectFromRouteState(state, PROJECT_ID)).toEqual({
      id: PROJECT_ID,
      title: "A new serial",
      userId: "user",
    });
  });

  it("recovers a failed create by retrying the same ID and looking up a committed project", async () => {
    const client = new QueryClient();
    const project = pendingProject(PROJECT_ID, "A new serial", "user");
    const record = {
      id: PROJECT_ID,
      title: project.title,
      project,
      accountSignal: ACCOUNT_SIGNAL,
      status: "failed" as const,
      error: "Response lost",
    };
    writeProjectCreation(client, record);
    const ids: string[] = [];
    const confirmed = serverProject();

    await expect(
      createProjectWithRecovery(
        { id: PROJECT_ID, title: project.title },
        async (input) => {
          ids.push(input.id);
          throw new Error("Response lost");
        },
        async () => {
          throw new Error("Project not found");
        },
      ),
    ).rejects.toThrow("Response lost");

    const retried = await createProjectWithRecovery(
      { id: PROJECT_ID, title: project.title },
      async (input) => {
        ids.push(input.id);
        throw new Error("Already created");
      },
      async (id) => {
        expect(id).toBe(PROJECT_ID);
        return confirmed;
      },
    );
    client.setQueryData(projectQueryKeys.detail(PROJECT_ID), retried);
    removeProjectCreation(client, PROJECT_ID);

    expect(ids).toEqual([PROJECT_ID, PROJECT_ID]);
    expect(readProjectCreation(client, PROJECT_ID)).toBeUndefined();
    expect(client.getQueryData(projectQueryKeys.detail(PROJECT_ID))).toEqual(confirmed);
  });

  it("discards the failed destination record", () => {
    const client = new QueryClient();
    const project = pendingProject(PROJECT_ID, "A new serial", "user");
    writeProjectCreation(client, {
      id: PROJECT_ID,
      title: project.title,
      project,
      accountSignal: ACCOUNT_SIGNAL,
      status: "failed",
      error: "Request failed",
    });
    removeProjectCreation(client, PROJECT_ID);

    expect(readProjectCreation(client, PROJECT_ID)).toBeUndefined();
  });
});
