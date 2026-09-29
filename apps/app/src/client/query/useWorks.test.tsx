// @vitest-environment jsdom
import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { archiveWork, listProjectWorks, updateWork } from "@/client/api/projects-api";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { projectQueryKeys } from "./project-query-keys";
import { useWorkMutations } from "./useWorks";
import { acquireWorksSnapshot } from "./works-projection-acquisition";

vi.mock("@/client/api/projects-api", () => ({
  archiveWork: vi.fn(),
  deleteWork: vi.fn(),
  listProjectWorks: vi.fn(),
  restoreWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

const PROJECT_ID = "project-1";
const WORK = {
  id: "work-1",
  projectId: PROJECT_ID,
  createdByUserId: "user-1",
  name: "Arc",
  slug: "arc",
  isNoWork: false,
  goal: null,
  status: "active",
  archivedAt: null,
  aiWriteMode: "direct",
  entityRevision: "1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  lastActivityAt: "2026-09-01T00:00:00.000Z",
  deletedAt: null,
} as Work;
const SNAPSHOT = {
  projectId: PROJECT_ID,
  catalogGeneration: "1",
  authorityRevision: "1",
  requestId: "request-1",
  works: [WORK],
  noWork: { ...WORK, id: "no-work", name: "No Work", isNoWork: true, slug: null },
} as unknown as WorksSnapshot;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let submitUpdate: (input: { workId: string; data: UpdateWorkRequest }) => Promise<Work>;
let submitArchive: (workId: string) => Promise<Work>;
function MutationProbe() {
  const { update, archive } = useWorkMutations(PROJECT_ID);
  submitUpdate = (input) => update.mutateAsync(input);
  submitArchive = (workId) => archive.mutateAsync(workId);
  return null;
}

describe("useWorkMutations update", () => {
  it("projects immediately, fences an older snapshot, and rolls back on failure", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), SNAPSHOT);
    const staleRead = deferred<WorksSnapshot>();
    const staleAcquisition = acquireWorksSnapshot(client, PROJECT_ID, () => staleRead.promise);
    const updateRequest = deferred<Work>();
    const updateStarted = deferred<void>();
    vi.mocked(updateWork).mockImplementation(() => {
      updateStarted.resolve();
      return updateRequest.promise;
    });
    vi.mocked(listProjectWorks).mockResolvedValue(SNAPSHOT);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <MutationProbe />
        </QueryClientProvider>,
        async () => {
          let mutation!: Promise<Work>;
          await act(async () => {
            mutation = submitUpdate({ workId: WORK.id, data: { name: "Revised arc" } });
            await updateStarted.promise;
          });
          expect(
            client.getQueryData<WorksSnapshot>(projectQueryKeys.works(PROJECT_ID))?.works[0]?.name,
          ).toBe("Revised arc");

          await act(async () => {
            staleRead.resolve(SNAPSHOT);
            await staleAcquisition;
          });
          expect(
            client.getQueryData<WorksSnapshot>(projectQueryKeys.works(PROJECT_ID))?.works[0]?.name,
          ).toBe("Revised arc");

          await act(async () => {
            updateRequest.reject(new Error("Rejected"));
            await expect(mutation).rejects.toThrow("Rejected");
          });
          expect(
            client.getQueryData<WorksSnapshot>(projectQueryKeys.works(PROJECT_ID))?.works[0]?.name,
          ).toBe("Arc");
        },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});

describe("useWorkMutations archive", () => {
  it("shows queued archives at once and rolls back only the rejected one", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const second = { ...WORK, id: "work-2", name: "Coda", slug: "coda" };
    const snapshot = { ...SNAPSHOT, works: [WORK, second] } as WorksSnapshot;
    client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot);
    const firstRequest = deferred<Work>();
    const secondRequest = deferred<Work>();
    vi.mocked(archiveWork)
      .mockImplementationOnce(() => firstRequest.promise)
      .mockImplementationOnce(() => secondRequest.promise);
    // Repair reads never land here: the test observes the projection only.
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    const statuses = () =>
      client
        .getQueryData<WorksSnapshot>(projectQueryKeys.works(PROJECT_ID))
        ?.works.map((work) => work.status);

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <MutationProbe />
        </QueryClientProvider>,
        async () => {
          let first!: Promise<Work>;
          await act(async () => {
            first = submitArchive(WORK.id);
            void submitArchive(second.id).catch(() => undefined);
          });
          await vi.waitFor(() => expect(statuses()).toEqual(["archived", "archived"]));
          // One lifecycle scope: the second command waits for the first on the network.
          expect(archiveWork).toHaveBeenCalledTimes(1);

          await act(async () => {
            firstRequest.reject(new Error("Rejected"));
            await expect(first).rejects.toThrow("Rejected");
          });
          expect(statuses()).toEqual(["active", "archived"]);
        },
      );
    } finally {
      client.clear();
      vi.clearAllMocks();
    }
  });
});
