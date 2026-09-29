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

const api = vi.hoisted(() => ({ createProject: vi.fn(), getProject: vi.fn() }));
vi.mock("@/client/api/projects-api", () => api);

const accountId = "account-a";
const otherAccountId = "account-b";
const persisted = (id: string) => ({ id, userId: accountId }) as Project;

afterEach(() => vi.resetAllMocks());

describe("project creation", () => {
  it("retries a failed attempt with the same identity and title", async () => {
    const projectId = crypto.randomUUID();
    const failure = new Error("offline");
    api.createProject.mockRejectedValueOnce(failure).mockResolvedValueOnce(persisted(projectId));
    api.getProject.mockRejectedValueOnce(failure);

    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).rejects.toBe(failure);
    expect(projectCreationFailed(projectId, accountId)).toBe(true);

    await retryProjectCreation(projectId, accountId);
    expect(api.createProject).toHaveBeenLastCalledWith({ id: projectId, title: "Fast project" });
    await waitForProjectCreation(projectId);
    expect(projectCreationFailed(projectId, accountId)).toBe(false);
  });

  it("recovers an ambiguous create only from the matching account project", async () => {
    const projectId = crypto.randomUUID();
    api.createProject.mockRejectedValueOnce(new Error("response lost"));
    api.getProject.mockResolvedValueOnce(persisted(projectId));

    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).resolves.toMatchObject({ id: projectId, userId: accountId });
    expect(isProjectCreationPending(projectId, accountId)).toBe(true);

    await waitForProjectCreation(projectId);
    expect(isProjectCreationPending(projectId, accountId)).toBe(false);
  });

  it("does not retry another account's failed attempt", async () => {
    const projectId = crypto.randomUUID();
    const failure = new Error("offline");
    api.createProject.mockRejectedValueOnce(failure);
    api.getProject.mockRejectedValueOnce(failure);
    await expect(
      beginProjectCreation({ projectId, accountId, title: "Fast project" }),
    ).rejects.toBe(failure);

    expect(() => retryProjectCreation(projectId, otherAccountId)).toThrow(
      "Project creation is not retryable",
    );
    expect(api.createProject).toHaveBeenCalledTimes(1);
  });

  it("forgets an attempt when its account epoch ends", async () => {
    const projectId = crypto.randomUUID();
    const accountEpoch = new AbortController();
    let resolve!: (project: Project) => void;
    api.createProject.mockReturnValueOnce(new Promise<Project>((done) => (resolve = done)));

    const persistence = beginProjectCreation(
      { projectId, accountId, title: "Fast project" },
      accountEpoch.signal,
    );
    expect(isProjectCreationPending(projectId, accountId)).toBe(true);

    accountEpoch.abort();
    expect(isProjectCreationPending(projectId, accountId)).toBe(false);
    resolve(persisted(projectId));
    await persistence;
  });
});
