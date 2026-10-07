// @vitest-environment jsdom
/**
 * Work commands show through `useWorks` as a projection over the server
 * snapshot: queued commands show at once, each failure stays on its own Work,
 * and no server read can hide a change whose command has not settled.
 */
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveWork,
  createProjectWork,
  deleteWork,
  listProjectWorks,
  unarchiveWork,
  updateWork,
} from "@/client/api/projects-api";
import { useWorkRename } from "@/features/project/work/WorkTitles";
import { withReactRoot } from "@/test-support/react-dom-harness";
import { archived, deferred, snapshot, WORK } from "@/test-support/works-fixtures";
import { projectQueryKeys } from "./project-query-keys";
import { useWorks } from "./useWorks";
import type { WorkCreation } from "./work-command-projection";
import {
  useWorkCommandFailures,
  useWorkDeleteWindows,
  type WorkCommandFailure,
  type WorkDeleteWindow,
} from "./work-command-selectors";
import { closeWorkDeleteWindow, useWorkMutations } from "./work-command-store";
import type { WorkCommandRecord, WorkMutations } from "./work-commands";
import { acquireWorksSnapshot } from "./works-projection-acquisition";

const account = vi.hoisted(() => ({ epoch: new AbortController() }));
vi.mock("@/features/project/context/account-feature-context", () => ({
  useOptionalAccountEpochSignal: () => account.epoch.signal,
}));
vi.mock("./useProjectCreation", () => ({ useIsProjectPendingCreation: () => false }));
vi.mock("@/client/api/projects-api", () => ({
  archiveWork: vi.fn(),
  createProjectWork: vi.fn(),
  deleteWork: vi.fn(),
  listProjectWorks: vi.fn(),
  restoreWork: vi.fn(),
  unarchiveWork: vi.fn(),
  updateWork: vi.fn(),
  updateWorkWriteMode: vi.fn(),
}));

beforeEach(() => notifyManager.setScheduler(queueMicrotask));
afterEach(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)));

const PROJECT_ID = WORK.projectId;
const SECOND = {
  ...WORK,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Coda",
  slug: "coda",
} as Work;
const OPERATIONS = ["create", "update", "archive", "unarchive"] as const;
type Seen = {
  works: Work[] | null;
  creations: ReadonlyMap<string, WorkCreation>;
  failures: ReadonlyMap<string, WorkCommandFailure>;
  windows: readonly WorkDeleteWindow[];
};
let commands!: WorkMutations;
let renameWork!: (name: string) => Promise<void>;
let seen: Seen = { works: null, creations: new Map(), failures: new Map(), windows: [] };
const renders: Seen[] = [];
function Probe() {
  commands = useWorkMutations(PROJECT_ID);
  const works = useWorks(PROJECT_ID);
  seen = {
    works: works.works,
    creations: works.creations,
    failures: useWorkCommandFailures(PROJECT_ID, OPERATIONS),
    windows: useWorkDeleteWindows(PROJECT_ID),
  };
  renders.push(seen);
  return null;
}

function RenameProbe() {
  renameWork = useWorkRename(PROJECT_ID, WORK);
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
        <RenameProbe />
      </QueryClientProvider>,
      () => run(client),
      { drainMacrotask: true },
    );
  } finally {
    client.clear();
    vi.resetAllMocks();
  }
}

const settle = async (check: () => void) => {
  await act(async () => {});
  check();
};
const recordStatuses = (client: QueryClient) =>
  (client.getQueryData<WorkCommandRecord[]>(projectQueryKeys.workCommands(PROJECT_ID)) ?? []).map(
    (record) => record.status,
  );

describe("Work command projection", () => {
  it("shows a rename at once, keeps it over an older read, and drops it on failure", async () => {
    const request = deferred<Work>();
    vi.mocked(updateWork).mockImplementation(() => request.promise);
    vi.mocked(listProjectWorks).mockResolvedValue(snapshot([WORK]));
    await withProbe(snapshot([WORK]), async (client) => {
      const staleRead = deferred<WorksSnapshot>();
      const stale = acquireWorksSnapshot(client, PROJECT_ID, () => staleRead.promise);
      let rename!: Promise<Error | null>;
      await act(async () => {
        rename = commands.update({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => expect(field(WORK.id, "name")).toBe("Revised arc"));

      await act(async () => {
        staleRead.resolve(snapshot([WORK], "2"));
        await stale;
      });
      expect(field(WORK.id, "name")).toBe("Revised arc");

      let outcome: Error | null = null;
      await act(async () => {
        request.reject(new Error("Rejected"));
        outcome = await rename;
      });
      await settle(() => expect(field(WORK.id, "name")).toBe("Arc"));
      // The rename reports its failure through its own promise; no record lingers.
      expect(outcome).toBeInstanceOf(Error);
      await expect(renameWork("Another title")).rejects.toBeInstanceOf(Error);
      expect(recordStatuses(client)).toEqual([]);
      expect(seen.failures.size).toBe(0);
    });
  });

  it("drops a failure the server kept anyway once the repair read shows it", async () => {
    vi.mocked(archiveWork).mockRejectedValue(new Error("Network lost"));
    vi.mocked(listProjectWorks).mockResolvedValue(snapshot([archived(WORK)], "2"));
    await withProbe(snapshot([WORK]), async (client) => {
      await act(async () => {
        await commands.archive({ workId: WORK.id });
      });
      await settle(() => {
        expect(recordStatuses(client)).toEqual([]);
        expect(field(WORK.id, "archivedAt")).not.toBeNull();
      });
      expect(seen.failures.size).toBe(0);
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
        void commands.archive({ workId: WORK.id });
        void commands.archive({ workId: SECOND.id });
      });
      await settle(() => {
        expect(field(WORK.id, "archivedAt")).not.toBeNull();
        expect(field(SECOND.id, "archivedAt")).not.toBeNull();
      });
      // One lifecycle scope: the second command waits for the first on the network.
      expect(archiveWork).toHaveBeenCalledTimes(1);

      await act(async () => first.reject(new Error("Rejected")));
      await settle(() => expect(seen.failures.get(WORK.id)?.operation).toBe("archive"));
      expect(field(WORK.id, "archivedAt")).toBeNull();
      expect(field(SECOND.id, "archivedAt")).not.toBeNull();
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
        void commands.archive({ workId: SECOND.id });
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(1));
      await act(async () => {
        void commands.update({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(2));

      await act(async () => archiveRead.resolve(snapshot([WORK, archived(SECOND)], "2")));
      // Deliver the controlled query notifications before inspecting the render.
      await settle(() => {
        expect(field(SECOND.id, "archivedAt")).not.toBeNull();
        expect(field(WORK.id, "name")).toBe("Revised arc");
      });

      await act(async () => renameRead.resolve(snapshot([renamed, archived(SECOND)], "3")));
      await settle(() => expect(recordStatuses(client)).toEqual([]));
      await settle(() => {
        expect(field(WORK.id, "name")).toBe("Revised arc");
        expect(field(SECOND.id, "archivedAt")).not.toBeNull();
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
        void commands.archive({ workId: WORK.id });
      });
      await settle(() => expect(field(WORK.id, "archivedAt")).not.toBeNull());
      await act(async () => {
        void commands.unarchive({ workId: WORK.id });
      });
      await settle(() => expect(field(WORK.id, "archivedAt")).toBeNull());
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
      expect(field(WORK.id, "archivedAt")).toBeNull();
    });
  });

  it("patches only the fields a command owns when the refresh after it fails", async () => {
    const renamed = { ...WORK, name: "Revised arc" } as Work;
    // The archive committed against the old name; a newer read already has the rename.
    vi.mocked(archiveWork).mockResolvedValue(archived(WORK));
    vi.mocked(listProjectWorks).mockRejectedValue(new Error("Offline"));
    await withProbe(snapshot([renamed], "2"), async (client) => {
      await act(async () => {
        await commands.archive({ workId: WORK.id });
      });
      await settle(() => {
        expect(recordStatuses(client)).toEqual([]);
        expect(field(WORK.id, "archivedAt")).not.toBeNull();
      });
      expect(field(WORK.id, "name")).toBe("Revised arc");
    });
  });

  it("closes a pending delete's Undo window at once, and drops its record when it lands", async () => {
    let server = snapshot([WORK]);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    const request = deferred<void>();
    vi.mocked(deleteWork).mockImplementation(() => request.promise);
    await withProbe(server, async (client) => {
      await act(async () => {
        void commands.delete({ workId: WORK.id });
      });
      await settle(() => expect(seen.windows.map((open) => open.workId)).toEqual([WORK.id]));

      await act(async () => closeWorkDeleteWindow(client, PROJECT_ID, WORK.id));
      await settle(() => expect(seen.windows).toEqual([]));
      expect(seen.works).toEqual([]);

      await act(async () => {
        server = snapshot([{ ...WORK, deletedAt: "2026-09-03T00:00:00.000Z" } as Work], "2");
        request.resolve();
      });
      await settle(() => expect(recordStatuses(client)).toEqual([]));
      expect(seen.windows).toEqual([]);
    });
  });

  it("drops every record on an account switch, and a command still running writes none", async () => {
    const request = deferred<Work>();
    vi.mocked(archiveWork)
      .mockRejectedValueOnce(new Error("Rejected"))
      .mockImplementationOnce(() => request.promise);
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    await withProbe(snapshot([WORK, SECOND]), async (client) => {
      await act(async () => {
        void commands.archive({ workId: WORK.id });
        void commands.archive({ workId: SECOND.id });
      });
      await settle(() => {
        expect(seen.failures.get(WORK.id)?.operation).toBe("archive");
        expect(field(SECOND.id, "archivedAt")).not.toBeNull();
      });
      const reads = vi.mocked(listProjectWorks).mock.calls.length;

      await act(async () => account.epoch.abort());
      await settle(() => {
        expect(seen.failures.size).toBe(0);
        expect(field(SECOND.id, "archivedAt")).toBeNull();
      });
      // The old account's commit neither reads nor patches the Works snapshot.
      await act(async () => request.resolve(archived(SECOND)));
      expect(listProjectWorks).toHaveBeenCalledTimes(reads);
      expect(recordStatuses(client)).toEqual([]);
    });
    account.epoch = new AbortController();
  });
});

describe("Work creation", () => {
  const CREATED = {
    ...WORK,
    id: "00000000-0000-4000-8000-000000000003",
    name: "Draft three",
    slug: "draft-three",
  } as Work;
  const CREATED_ID = CREATED.id as ParsedRequestId;

  it("keeps a confirmed Work in every reader until the snapshot includes it", async () => {
    const post = deferred<Work>();
    vi.mocked(createProjectWork).mockImplementation(() => post.promise);
    const refresh = deferred<WorksSnapshot>();
    vi.mocked(listProjectWorks).mockImplementation(() => refresh.promise);
    await withProbe(snapshot([WORK]), async (client) => {
      // A read already on its way when the POST commits, without the new Work.
      const staleRead = deferred<WorksSnapshot>();
      const stale = acquireWorksSnapshot(client, PROJECT_ID, () => staleRead.promise);
      await act(async () => {
        void commands.create({ workId: CREATED_ID, name: "Draft three" });
      });
      await settle(() => expect(seen.creations.get(CREATED.id)?.phase).toBe("pending"));
      expect(seen.works?.map((work) => work.id)).toEqual([WORK.id]);

      await act(async () => post.resolve(CREATED));
      await settle(() => expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]));
      const confirmed = renders.length - 1;
      expect(seen.creations.size).toBe(0);

      await act(async () => {
        staleRead.resolve(snapshot([WORK], "2"));
        await stale;
      });
      await act(async () => refresh.resolve(snapshot([CREATED, WORK], "3")));
      await settle(() => expect(recordStatuses(client)).toEqual([]));
      expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]);
      for (const render of renders.slice(confirmed))
        expect(render.works?.map((work) => work.id)).toContain(CREATED.id);
    });
  });

  it("shows a refused Work as not created, and a retry creates it", async () => {
    vi.mocked(createProjectWork)
      .mockRejectedValueOnce(new Error("Rejected"))
      .mockResolvedValueOnce(CREATED);
    let server = snapshot([WORK]);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    await withProbe(server, async () => {
      await act(async () => {
        void commands.create({ workId: CREATED_ID, name: "Draft three" });
      });
      await settle(() => expect(seen.creations.get(CREATED.id)?.phase).toBe("failed"));
      expect(seen.creations.get(CREATED.id)?.work.name).toBe("Draft three");
      expect(seen.works?.map((work) => work.id)).toEqual([WORK.id]);

      server = snapshot([CREATED, WORK], "2");
      await act(async () => {
        await seen.failures.get(CREATED.id)?.retry();
      });
      await settle(() => expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]));
      expect(seen.creations.size).toBe(0);
      expect(seen.failures.size).toBe(0);
    });
  });

  it("recovers a Work whose POST response was lost, by its own id", async () => {
    vi.mocked(createProjectWork).mockRejectedValue(new Error("Network lost"));
    vi.mocked(listProjectWorks).mockImplementation(async () => snapshot([CREATED, WORK], "2"));
    await withProbe(snapshot([WORK]), async (client) => {
      let outcome: Error | null | undefined;
      await act(async () => {
        outcome = await commands.create({ workId: CREATED_ID, name: "Draft three" });
      });
      expect(outcome).toBeNull();
      await settle(() => expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]));
      expect(recordStatuses(client)).toEqual([]);
      expect(seen.creations.size).toBe(0);
    });
  });
});
