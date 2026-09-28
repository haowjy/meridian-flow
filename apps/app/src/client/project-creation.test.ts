/** Same-tab creation sequencing and retry contracts. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginProjectCreation,
  isProjectCreationPending,
  projectCreationFailed,
  retryProjectCreation,
  waitForProjectCreation,
} from "./project-creation";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  getProject: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => ({
  createProject: mocks.createProject,
  getProject: mocks.getProject,
}));

const accountId = "00000000-0000-4000-8000-000000000001";

function project(id: string): Project {
  const timestamp = "2026-09-28T00:00:00.000Z";
  return {
    id,
    userId: accountId,
    slug: "fast-project",
    isPersonal: false,
    settings: {},
    lastActivityAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    title: "Fast project",
    description: null,
  };
}

afterEach(() => {
  mocks.createProject.mockReset();
  mocks.getProject.mockReset();
});

describe("project creation", () => {
  it("retries a failed attempt with the same project identity and title", async () => {
    const projectId = "00000000-0000-4000-8000-000000000002";
    const failure = new Error("offline");
    mocks.createProject.mockRejectedValueOnce(failure).mockResolvedValueOnce(project(projectId));
    mocks.getProject.mockRejectedValueOnce(failure);

    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).rejects.toBe(failure);
    expect(projectCreationFailed(projectId, accountId)).toBe(true);

    await expect(retryProjectCreation(projectId, accountId)).resolves.toMatchObject({
      id: projectId,
    });
    expect(mocks.createProject).toHaveBeenNthCalledWith(2, {
      id: projectId,
      title: "Fast project",
    });
    await waitForProjectCreation(projectId);
    expect(projectCreationFailed(projectId, accountId)).toBe(false);
  });

  it("recovers an ambiguous create only from the matching account project", async () => {
    const projectId = "00000000-0000-4000-8000-000000000003";
    mocks.createProject.mockRejectedValueOnce(new Error("response lost"));
    mocks.getProject.mockResolvedValueOnce(project(projectId));

    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).resolves.toMatchObject({ id: projectId, userId: accountId });
    expect(isProjectCreationPending(projectId, accountId)).toBe(true);

    await waitForProjectCreation(projectId);
    expect(isProjectCreationPending(projectId, accountId)).toBe(false);
  });

  it("does not retry an earlier account's failed attempt", async () => {
    const projectId = "00000000-0000-4000-8000-000000000004";
    const failure = new Error("offline");
    mocks.createProject.mockRejectedValueOnce(failure);
    mocks.getProject.mockRejectedValueOnce(failure);
    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).rejects.toBe(failure);

    expect(() => retryProjectCreation(projectId, "00000000-0000-4000-8000-000000000099")).toThrow(
      "Project creation is not retryable",
    );
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it("does not accept another account's project as ambiguous-create recovery", async () => {
    const projectId = "00000000-0000-4000-8000-000000000005";
    const failure = new Error("response lost");
    mocks.createProject.mockRejectedValueOnce(failure);
    mocks.getProject.mockResolvedValueOnce({
      ...project(projectId),
      userId: "00000000-0000-4000-8000-000000000099",
    });

    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).rejects.toBe(failure);
    expect(projectCreationFailed(projectId, accountId)).toBe(true);
  });

  it("forgets an attempt when its account epoch ends", async () => {
    const projectId = "00000000-0000-4000-8000-000000000006";
    const accountEpoch = new AbortController();
    let resolve!: (value: Project) => void;
    mocks.createProject.mockReturnValueOnce(
      new Promise<Project>((done) => {
        resolve = done;
      }),
    );

    const persistence = beginProjectCreation(
      { projectId, accountId, title: "Fast project" },
      accountEpoch.signal,
    );
    expect(isProjectCreationPending(projectId, accountId)).toBe(true);

    accountEpoch.abort();
    expect(isProjectCreationPending(projectId, accountId)).toBe(false);
    resolve(project(projectId));
    await expect(persistence).resolves.toMatchObject({ id: projectId });
  });
});
