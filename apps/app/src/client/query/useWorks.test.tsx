// @vitest-environment jsdom
import type { UpdateWorkRequest, Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { listProjectWorks, updateWork } from "@/client/api/projects-api";
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
function MutationProbe() {
  const { update } = useWorkMutations(PROJECT_ID);
  submitUpdate = (input) => update.mutateAsync(input);
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
