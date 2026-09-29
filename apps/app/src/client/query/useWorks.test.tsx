// @vitest-environment jsdom
/**
 * Work commands show through `useWorks` as a projection over the server
 * snapshot: queued commands show at once, each failure stays on its own Work,
 * and no server read can hide a change whose command has not settled.
 */
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  archiveWork,
  deleteWork,
  listProjectWorks,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { projectQueryKeys } from "./project-query-keys";
import {
  useWorkCommandFailures,
  useWorkMutations,
  useWorks,
  type WorkCommandFailure,
  type WorkMutations,
} from "./useWorks";
import { acquireWorksSnapshot } from "./works-projection-acquisition";

vi.mock("./useProjectCreation", () => ({ useIsProjectPendingCreation: () => false }));
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
const SECOND = { ...WORK, id: "work-2", name: "Coda", slug: "coda" } as Work;
const snapshot = (works: Work[], authorityRevision = "1") =>
  ({
    projectId: PROJECT_ID,
    catalogGeneration: "1",
    authorityRevision,
    requestId: `request-${authorityRevision}`,
    works,
    noWork: { ...WORK, id: "no-work", name: "No Work", isNoWork: true, slug: null },
  }) as unknown as WorksSnapshot;
const archived = (work: Work) =>
  ({ ...work, status: "archived", archivedAt: "2026-09-02T00:00:00.000Z" }) as Work;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const OPERATIONS = ["update", "archive", "unarchive"] as const;
type Seen = { works: Work[] | null; failures: ReadonlyMap<string, WorkCommandFailure> };
let commands!: WorkMutations;
let seen: Seen = { works: null, failures: new Map() };
const renders: Seen[] = [];
function Probe() {
  commands = useWorkMutations(PROJECT_ID);
  seen = {
    works: useWorks(PROJECT_ID).works,
    failures: useWorkCommandFailures(PROJECT_ID, OPERATIONS),
  };
  renders.push(seen);
  return null;
}

const field = <K extends keyof Work>(id: string, key: K) =>
  seen.works?.find((work) => work.id === id)?.[key];

async function withProbe(server: WorksSnapshot, run: (client: QueryClient) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(projectQueryKeys.works(PROJECT_ID), server);
  renders.length = 0;
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
      () => run(client),
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
    vi.resetAllMocks();
  }
}

const settle = (check: () => void) => act(() => vi.waitFor(check));

describe("Work command projection", () => {
  it("shows a rename at once, keeps it over an older read, and drops it on failure", async () => {
    const request = deferred<Work>();
    vi.mocked(updateWork).mockImplementation(() => request.promise);
    vi.mocked(listProjectWorks).mockResolvedValue(snapshot([WORK]));
    await withProbe(snapshot([WORK]), async (client) => {
      const staleRead = deferred<WorksSnapshot>();
      const stale = acquireWorksSnapshot(client, PROJECT_ID, () => staleRead.promise);
      let rename!: Promise<Work>;
      await act(async () => {
        rename = commands.update.mutateAsync({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => expect(field(WORK.id, "name")).toBe("Revised arc"));

      await act(async () => {
        staleRead.resolve(snapshot([WORK], "2"));
        await stale;
      });
      expect(field(WORK.id, "name")).toBe("Revised arc");

      await act(async () => {
        request.reject(new Error("Rejected"));
        await rename.catch(() => undefined);
      });
      await settle(() => expect(field(WORK.id, "name")).toBe("Arc"));
      expect(seen.failures.get(WORK.id)?.operation).toBe("update");
    });
  });

  it("keeps the failure of the first of two queued archives", async () => {
    const first = deferred<Work>();
    const second = deferred<Work>();
    vi.mocked(archiveWork)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    // Snapshot reads never land: the test observes the projection only.
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    await withProbe(snapshot([WORK, SECOND]), async () => {
      await act(async () => {
        void commands.archive.mutateAsync(WORK.id).catch(() => undefined);
        void commands.archive.mutateAsync(SECOND.id).catch(() => undefined);
      });
      await settle(() => {
        expect(field(WORK.id, "status")).toBe("archived");
        expect(field(SECOND.id, "status")).toBe("archived");
      });
      // One lifecycle scope: the second command waits for the first on the network.
      expect(archiveWork).toHaveBeenCalledTimes(1);

      await act(async () => first.reject(new Error("Rejected")));
      await settle(() => expect(seen.failures.get(WORK.id)?.operation).toBe("archive"));
      expect(field(WORK.id, "status")).toBe("active");
      expect(field(SECOND.id, "status")).toBe("archived");
      expect(seen.failures.has(SECOND.id)).toBe(false);

      await act(async () => seen.failures.get(WORK.id)?.dismiss());
      await settle(() => expect(seen.failures.size).toBe(0));
    });
  });

  it("does not let a read that started before a commit hide that commit", async () => {
    // Archive's read captures the server before the rename commits, but lands
    // with a newer revision than the cache holds.
    const archiveRead = deferred<WorksSnapshot>();
    const renameRead = deferred<WorksSnapshot>();
    vi.mocked(listProjectWorks)
      .mockImplementationOnce(() => archiveRead.promise)
      .mockImplementationOnce(() => renameRead.promise);
    vi.mocked(archiveWork).mockImplementation(async () => archived(SECOND));
    const renamed = { ...WORK, name: "Revised arc" } as Work;
    vi.mocked(updateWork).mockImplementation(async () => renamed);
    await withProbe(snapshot([WORK, SECOND]), async (client) => {
      await act(async () => {
        void commands.archive.mutateAsync(SECOND.id);
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(1));
      await act(async () => {
        void commands.update.mutateAsync({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(2));

      await act(async () => archiveRead.resolve(snapshot([WORK, archived(SECOND)], "2")));
      // Query and mutation notifications flush on a timer; wait for the render.
      await settle(() => {
        expect(field(SECOND.id, "status")).toBe("archived");
        expect(field(WORK.id, "name")).toBe("Revised arc");
      });

      await act(async () => renameRead.resolve(snapshot([renamed, archived(SECOND)], "3")));
      await settle(() => expect(client.getMutationCache().getAll()).toHaveLength(0));
      await settle(() => {
        expect(field(WORK.id, "name")).toBe("Revised arc");
        expect(field(SECOND.id, "status")).toBe("archived");
      });
      const shown = renders.findIndex((render) => render.works?.[0]?.name === "Revised arc");
      expect(renders.slice(shown).map((render) => render.works?.[0]?.name)).not.toContain("Arc");
    });
  });

  it("archives then unarchives without showing the archived state in between", async () => {
    let server = snapshot([WORK]);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    const archiveRequest = deferred<Work>();
    vi.mocked(archiveWork).mockImplementation(() => archiveRequest.promise);
    vi.mocked(unarchiveWork).mockImplementation(async () => {
      server = snapshot([WORK], "3");
      return WORK;
    });
    await withProbe(server, async () => {
      await act(async () => {
        void commands.archive.mutateAsync(WORK.id);
      });
      await settle(() => expect(field(WORK.id, "status")).toBe("archived"));
      await act(async () => {
        void commands.unarchive.mutateAsync(WORK.id);
      });
      await settle(() => expect(field(WORK.id, "status")).toBe("active"));
      const back = renders.length - 1;

      await act(async () => {
        server = snapshot([archived(WORK)], "2");
        archiveRequest.resolve(archived(WORK));
      });
      await settle(() => expect(unarchiveWork).toHaveBeenCalledTimes(1));
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(2));
      expect(renders.slice(back).map((render) => render.works?.[0]?.status)).not.toContain(
        "archived",
      );
      expect(field(WORK.id, "status")).toBe("active");
    });
  });
  it("hides a failure once the server already shows its target", async () => {
    vi.mocked(archiveWork).mockRejectedValue(new Error("Rejected"));
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    await withProbe(snapshot([WORK]), async (client) => {
      await act(async () => {
        void commands.archive.mutateAsync(WORK.id).catch(() => undefined);
      });
      await settle(() => expect(seen.failures.get(WORK.id)?.operation).toBe("archive"));

      // Another device archived it: Retry would be a no-op, so the failure goes quiet.
      await act(async () => {
        client.setQueryData(projectQueryKeys.works(PROJECT_ID), snapshot([archived(WORK)], "2"));
      });
      await settle(() => expect(seen.failures.size).toBe(0));
      expect(field(WORK.id, "status")).toBe("archived");
    });
  });

  it("patches only the fields a command owns when the refresh after it fails", async () => {
    const renamed = { ...WORK, name: "Revised arc" } as Work;
    // The archive committed against the old name; a newer read already has the rename.
    vi.mocked(archiveWork).mockResolvedValue(archived(WORK));
    vi.mocked(listProjectWorks).mockRejectedValue(new Error("Offline"));
    await withProbe(snapshot([renamed], "2"), async (client) => {
      await act(async () => {
        await commands.archive.mutateAsync(WORK.id);
      });
      await settle(() => {
        expect(client.getMutationCache().getAll()).toHaveLength(0);
        expect(field(WORK.id, "status")).toBe("archived");
      });
      expect(field(WORK.id, "name")).toBe("Revised arc");
    });
  });

  it("drops a success record once it lands, and keeps a delete's as its Undo window", async () => {
    let server = snapshot([WORK]);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    vi.mocked(updateWork).mockImplementation(async () => {
      server = snapshot([{ ...WORK, name: "Revised arc" } as Work], "2");
      return server.works[0] as Work;
    });
    vi.mocked(deleteWork).mockImplementation(async () => {
      server = snapshot([{ ...WORK, deletedAt: "2026-09-03T00:00:00.000Z" } as Work], "3");
    });
    await withProbe(server, async (client) => {
      await act(async () => {
        await commands.update.mutateAsync({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => {
        expect(client.getMutationCache().getAll()).toHaveLength(0);
        expect(field(WORK.id, "name")).toBe("Revised arc");
      });

      await act(async () => {
        await commands.delete.mutateAsync(WORK.id);
      });
      await settle(() => expect(seen.works).toEqual([]));
      expect(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state.status),
      ).toEqual(["success"]);
    });
  });
});
