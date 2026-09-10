import type { Work } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { parseExplicitWork, resolveRouteWork } from "@/features/project/routing/project-route";
import { withReactRoot } from "@/test-support/react-dom-harness";

const api = vi.hoisted(() => ({
  listProjectWorks: vi.fn(),
  createProjectWork: vi.fn(),
  updateWork: vi.fn(),
  archiveWork: vi.fn(),
  unarchiveWork: vi.fn(),
  deleteWork: vi.fn(),
  restoreWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

vi.mock("@/client/api/projects-api", () => api);
vi.mock("@/client/stores", () => ({
  useIsProjectPendingCreation: () => false,
}));

const { useUpdateWorkWriteMode, useWorkMutations, useWorks } = await import("./useWorks");
const { projectQueryKeys } = await import("./project-query-keys");
const { seedProjectRouteData } = await import("./project-route-data");
const { beginWorksSnapshotRequest } = await import("./works-projection-acquisition");
const { threadQueryKeys } = await import("./thread-query-keys");

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe("Work client queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listProjectWorks.mockResolvedValue(snapshot([]));
  });

  it("loads the complete Work catalog, including archived Works", async () => {
    api.listProjectWorks.mockResolvedValue(snapshot([]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const state: { value: ReturnType<typeof useWorks> | null } = { value: null };

    function Harness() {
      state.value = useWorks("project-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await flush();
          expect(api.listProjectWorks).toHaveBeenCalledWith("project-1");
          expect(state.value?.works).toEqual([]);
          expect(state.value?.status).toBe("empty");
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });

  it("keeps a newer-started equal-authority loader seed over an older mounted query", async () => {
    let resolveOlder!: (value: ReturnType<typeof snapshot>) => void;
    api.listProjectWorks.mockImplementation(
      () => new Promise((resolve) => (resolveOlder = resolve)),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      useWorks("project-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await flush();
        const loaderStarted = beginWorksSnapshotRequest("project-1");
        seedProjectRouteData(client, "project-1", {
          threads: null,
          works: snapshot([{ id: "work-1", name: "newer loader" } as Work], "2"),
          worksStarted: loaderStarted,
          workingSet: { status: "absent" },
        });
        resolveOlder(snapshot([{ id: "work-1", name: "older in-flight" } as Work], "2"));
        await flush();
        expect(
          client.getQueryData<ReturnType<typeof snapshot>>(projectQueryKeys.works("project-1"))
            ?.works[0]?.name,
        ).toBe("newer loader");
      },
      { drainMacrotask: true },
    );
    client.clear();
  });

  it.each([
    { type: "create", data: { name: "New Work" } },
    { type: "update", workId: "work-1", data: { name: "Renamed Work" } },
    { type: "archive", workId: "work-1" },
    { type: "unarchive", workId: "work-1" },
    { type: "delete", workId: "work-1" },
  ] as const)("invalidates Home after Work $type", async (action) => {
    const client = new QueryClient();
    const homeKey = projectQueryKeys.homeFeed("project-1");
    const associated = projectQueryKeys.workThreads("project-1", "work-1");
    client.setQueryData(homeKey, { fresh: true });
    client.setQueryData(associated, { fresh: true });
    const state: { value: ReturnType<typeof useWorkMutations> | null } = { value: null };

    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            if (!state.value) throw new Error("mutation commands did not mount");
            switch (action.type) {
              case "create":
                await state.value.create.mutateAsync(action.data);
                break;
              case "update":
                await state.value.update.mutateAsync({ workId: action.workId, data: action.data });
                break;
              case "archive":
                await state.value.archive.mutateAsync(action.workId);
                break;
              case "unarchive":
                await state.value.unarchive.mutateAsync(action.workId);
                break;
              case "delete":
                await state.value.delete.mutateAsync(action.workId);
                break;
            }
          });
          expect(client.getQueryState(homeKey)?.isInvalidated).toBe(true);
          expect(client.getQueryState(associated)?.isInvalidated).toBe(action.type !== "create");
        },
      );
    } finally {
      client.clear();
    }
  });

  it("adopts a created Work into the catalog before route resolution", async () => {
    const created = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "New Work",
    } as Work;
    api.createProjectWork.mockResolvedValue(created);
    api.listProjectWorks.mockResolvedValue(snapshot([created], "1"));
    const client = new QueryClient();
    client.setQueryData(projectQueryKeys.works("project-1"), snapshot([]));
    const state: { value: ReturnType<typeof useWorkMutations> | null } = { value: null };
    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        await act(async () => {
          await state.value?.create.mutateAsync({ name: "New Work" });
        });
        const catalog = client.getQueryData<{
          works: (typeof created)[];
        }>(projectQueryKeys.works("project-1"));
        expect(catalog?.works).toEqual([{ ...created, unpushedChangeCount: 0 }]);
        expect(
          resolveRouteWork(parseExplicitWork(created.id), {
            status: "success",
            works: catalog?.works ?? [],
          }).status,
        ).toBe("present");
      },
    );
    client.clear();
  });

  it("preserves each command's truthful result type and runtime value", async () => {
    type Commands = ReturnType<typeof useWorkMutations>;
    expectTypeOf<ReturnType<Commands["create"]["mutateAsync"]>>().toEqualTypeOf<Promise<Work>>();
    expectTypeOf<ReturnType<Commands["update"]["mutateAsync"]>>().toEqualTypeOf<Promise<Work>>();
    expectTypeOf<ReturnType<Commands["archive"]["mutateAsync"]>>().toEqualTypeOf<Promise<Work>>();
    expectTypeOf<ReturnType<Commands["unarchive"]["mutateAsync"]>>().toEqualTypeOf<Promise<Work>>();
    expectTypeOf<ReturnType<Commands["delete"]["mutateAsync"]>>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<Commands["create"]>().not.toHaveProperty("reset");

    const created = { id: "work-created", name: "Created" } as Work;
    const updated = { id: "work-updated", name: "Updated" } as Work;
    const archived = { id: "work-archived", status: "archived" } as Work;
    const unarchived = { id: "work-unarchived", status: "active" } as Work;
    api.createProjectWork.mockResolvedValue(created);
    api.updateWork.mockResolvedValue(updated);
    api.archiveWork.mockResolvedValue(archived);
    api.unarchiveWork.mockResolvedValue(unarchived);
    api.deleteWork.mockResolvedValue(undefined);
    const client = new QueryClient();
    const state: { value: Commands | null } = { value: null };
    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        if (!state.value) throw new Error("mutation commands did not mount");
        await expect(state.value.create.mutateAsync({ name: "Created" })).resolves.toBe(created);
        await expect(
          state.value.update.mutateAsync({ workId: "work-updated", data: { name: "Updated" } }),
        ).resolves.toBe(updated);
        await expect(state.value.archive.mutateAsync("work-archived")).resolves.toBe(archived);
        await expect(state.value.unarchive.mutateAsync("work-unarchived")).resolves.toBe(
          unarchived,
        );
        await expect(state.value.delete.mutateAsync("work-deleted")).resolves.toBeUndefined();
      },
    );
    client.clear();
  });

  it("keeps same-turn lifecycle admissions pending while their shared scope serializes them", async () => {
    let finishArchive!: (work: Work) => void;
    let finishDelete!: () => void;
    const archived = { id: "work-1", status: "archived" } as Work;
    api.archiveWork.mockImplementation(
      () => new Promise<Work>((resolve) => (finishArchive = resolve)),
    );
    api.deleteWork.mockImplementation(
      () => new Promise<void>((resolve) => (finishDelete = resolve)),
    );
    const client = new QueryClient();
    const state: { value: ReturnType<typeof useWorkMutations> | null } = { value: null };
    function Harness() {
      state.value = useWorkMutations("project-1");
      return null;
    }
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
      async () => {
        if (!state.value) throw new Error("mutation commands did not mount");
        const commands = state.value;
        let archivePromise!: Promise<Work>;
        let deletePromise!: Promise<void>;
        act(() => {
          archivePromise = commands.archive.mutateAsync("work-1");
          deletePromise = commands.delete.mutateAsync("work-1");
        });
        await flush();

        expect(api.archiveWork).toHaveBeenCalledOnce();
        expect(api.deleteWork).not.toHaveBeenCalled();
        expect(state.value?.archive.isPending).toBe(true);
        expect(state.value?.delete.isPending).toBe(true);
        expect(state.value?.isPending).toBe(true);

        finishArchive(archived);
        await expect(archivePromise).resolves.toBe(archived);
        await flush();
        expect(api.deleteWork).toHaveBeenCalledOnce();
        expect(state.value?.archive.isPending).toBe(false);
        expect(state.value?.delete.isPending).toBe(true);
        expect(state.value?.isPending).toBe(true);

        finishDelete();
        await expect(deletePromise).resolves.toBeUndefined();
        await flush();
        expect(state.value?.delete.isPending).toBe(false);
        expect(state.value?.isPending).toBe(false);
      },
      { drainMacrotask: true },
    );
    client.clear();
  });

  it.each([
    "confirmation_required",
    "updated",
  ] as const)("invalidates every Work push projection after %s", async (status) => {
    api.updateWorkWriteMode.mockResolvedValue(
      status === "updated"
        ? { status, aiWriteMode: "direct", pendingChangeCount: 0 }
        : { status, aiWriteMode: "draft", pendingChangeCount: 2 },
    );
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const state: { value: ReturnType<typeof useUpdateWorkWriteMode> | null } = { value: null };

    function Harness() {
      state.value = useUpdateWorkWriteMode("project-1", "work-1");
      return null;
    }

    try {
      await withReactRoot(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
        async () => {
          await act(async () => {
            await state.value?.mutateAsync({ aiWriteMode: "direct", confirmedPush: true });
          });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: projectQueryKeys.workDrafts("project-1", "work-1"),
          });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: projectQueryKeys.threads("project-1"),
          });
          expect(invalidate).toHaveBeenCalledWith({ queryKey: threadQueryKeys.all });
          expect(invalidate).toHaveBeenCalledWith({
            queryKey: ["projects", "project-1", "works", "work-1", "documents"],
          });
        },
        { drainMacrotask: true },
      );
    } finally {
      client.clear();
    }
  });
});

function snapshot(works: Work[], authorityRevision = "0") {
  return {
    projectId: "project-1",
    catalogGeneration: "generation-1",
    authorityRevision,
    requestId: `request-${authorityRevision}`,
    works: works.map((work) => ({ ...work, unpushedChangeCount: work.unpushedChangeCount ?? 0 })),
  };
}
