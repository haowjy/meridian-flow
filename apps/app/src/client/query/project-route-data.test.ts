/** Project entry starts independent owner-gated reads together. */
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectEntry } from "./project-route-data";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listProjectThreads: vi.fn(),
  listProjectWorks: vi.fn(),
  getProjectWorkingSet: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => mocks);
vi.mock("@/client/api/ssr-api-request", () => ({ ssrApiRequestInit: () => ({}) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const projectId = "00000000-0000-4000-8000-000000000010";
const accountId = "00000000-0000-4000-8000-000000000011";
const project: Project = {
  id: projectId,
  userId: accountId,
  slug: "entry",
  isPersonal: false,
  settings: {},
  lastActivityAt: "2026-09-28T00:00:00.000Z",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  deletedAt: null,
  title: "Entry",
  description: null,
};

afterEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("loadProjectEntry", () => {
  it("overlaps project identity with threads, Works, and working-set reads", async () => {
    const detail = deferred<Project>();
    mocks.getProject.mockReturnValue(detail.promise);
    mocks.listProjectThreads.mockResolvedValue([]);
    mocks.listProjectWorks.mockResolvedValue({ projectId } as never);
    mocks.getProjectWorkingSet.mockResolvedValue(null);

    const loading = loadProjectEntry(projectId);
    await Promise.resolve();

    expect(mocks.getProject).toHaveBeenCalledTimes(1);
    expect(mocks.listProjectThreads).toHaveBeenCalledTimes(1);
    expect(mocks.listProjectWorks).toHaveBeenCalledTimes(1);
    expect(mocks.getProjectWorkingSet).toHaveBeenCalledTimes(1);

    detail.resolve(project);
    await expect(loading).resolves.toMatchObject({ project });
  });
});
