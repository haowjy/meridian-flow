// @vitest-environment jsdom
/**
 * Work commands show through `useWorks` as a projection over the server
 * snapshot: unsettled commands show at once, each failure stays on its own Work,
 * and no server read can hide a change the server has not yet shown. The commands
 * run on a real command driver over an in-memory journal and a scripted server.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Work command patch ownership
 * - Work deletion Undo window
 */
import {
  CommandDriver,
  type TransportAnswer,
  type TransportRequest,
} from "@meridian/command-driver";
import { createMemoryJournal } from "@meridian/command-driver/memory-journal";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import type { Work, WorksSnapshot } from "@meridian/contracts/works";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listProjectWorks } from "@/client/api/projects-api";
import { CommandDriverContext } from "@/client/commands/driver-context";
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
import { workDomain } from "./work-commands";
import { closeWorkDeleteWindow, useWorkMutations, type WorkMutations } from "./work-mutations";
import { acquireWorksSnapshot, refreshWorksSnapshot } from "./works-projection-acquisition";

vi.mock("@/client/api/projects-api", () => ({ listProjectWorks: vi.fn() }));

beforeEach(() => notifyManager.setScheduler(queueMicrotask));
afterEach(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)));

const PROJECT_ID = WORK.projectId;
const SECOND = {
  ...WORK,
  id: "00000000-0000-4000-8000-000000000002",
  name: "Coda",
  handle: "w2",
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

type Answer = Promise<{ work?: Work } | "refuse">;
let respond: (request: TransportRequest) => Answer = async () => ({});
let driver!: CommandDriver;
const stored = new Map<string, unknown>();
const requests: TransportRequest[] = [];

const transport = async (request: TransportRequest): Promise<TransportAnswer> => {
  requests.push(request);
  if (request.path.endsWith("/resolve")) {
    const id = request.path.split("/").at(-2) as string;
    return {
      status: 200,
      code: null,
      body: { commandId: id, outcome: stored.get(id) ?? { status: "never" } },
    };
  }
  const answer = await respond(request);
  const commandId = (request.body as { commandId: string }).commandId;
  if (answer === "refuse") {
    stored.set(commandId, {
      status: "refused",
      result: { status: "refused", refusal: { error: "locked" } },
    });
    return { status: 400, code: "work_locked", body: null };
  }
  return { status: 200, code: null, body: answer.work ?? null };
};

async function withProbe(server: WorksSnapshot, run: (client: QueryClient) => Promise<void>) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  client.setQueryData(projectQueryKeys.works(PROJECT_ID), server);
  const domain = workDomain(client);
  driver = new CommandDriver({
    journal: createMemoryJournal(),
    lock: { acquire: async () => () => undefined },
    transport,
    changes: { post() {}, subscribe: () => () => undefined, close() {} },
    online: () => true,
    held: () => false,
    unreadable: () => {},
    routes: {
      lookup: (id) => `/api/commands/${id}`,
      resolve: (id) => `/api/commands/${id}/resolve`,
    },
    kinds: domain.kinds,
    log() {},
  });
  await driver.open();
  const unbind = domain.bind(driver, "account");
  renders.length = 0;
  requests.length = 0;
  stored.clear();
  try {
    await withReactRoot(
      <QueryClientProvider client={client}>
        <CommandDriverContext.Provider value={driver}>
          <Probe />
          <RenameProbe />
        </CommandDriverContext.Provider>
      </QueryClientProvider>,
      () => run(client),
      { drainMacrotask: true },
    );
  } finally {
    unbind();
    driver.stop();
    client.clear();
    vi.resetAllMocks();
  }
}

const settle = async (check: () => void) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  check();
};
const posts = () => requests.filter((request) => !request.path.endsWith("/resolve"));

describe("Work command projection", () => {
  it("shows a rename at once, keeps it over an older read, and drops it on failure", async () => {
    const request = deferred<"refuse">();
    respond = () => request.promise;
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
        request.resolve("refuse");
        outcome = await rename;
      });
      await settle(() => expect(field(WORK.id, "name")).toBe("Arc"));
      expect(outcome).toBeInstanceOf(Error);
      respond = async () => "refuse";
      await expect(renameWork("Another title")).rejects.toBeInstanceOf(Error);
      expect(driver.getSnapshot().records).toEqual([]);
      expect(seen.failures.size).toBe(0);
    });
  });

  it("sends lifecycle moves one at a time per project, and a Work's in order", async () => {
    const first = deferred<"refuse">();
    respond = (request) =>
      request.path.includes(WORK.id) && request.path.endsWith("/archive")
        ? first.promise
        : Promise.resolve({ work: archived(SECOND) });
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    await withProbe(snapshot([WORK, SECOND]), async () => {
      await act(async () => {
        void commands.archive({ workId: WORK.id });
        void commands.unarchive({ workId: WORK.id });
        void commands.archive({ workId: SECOND.id });
      });
      await settle(() => expect(field(SECOND.id, "archivedAt")).not.toBeNull());
      expect(posts().map((request) => request.path)).toEqual([`/api/works/${WORK.id}/archive`]);

      await act(async () => first.resolve("refuse"));
      await settle(() => expect(posts()).toHaveLength(3));
      expect(posts().map((request) => request.path)).toEqual([
        `/api/works/${WORK.id}/archive`,
        `/api/works/${WORK.id}/unarchive`,
        `/api/works/${SECOND.id}/archive`,
      ]);
    });
  });

  it("shows a refused archive on its Work until dismissed", async () => {
    respond = async (request) => (request.path.includes(WORK.id) ? "refuse" : {});
    vi.mocked(listProjectWorks).mockImplementation(() => new Promise(() => undefined));
    await withProbe(snapshot([WORK, SECOND]), async () => {
      await act(async () => {
        void commands.archive({ workId: WORK.id });
      });
      await settle(() => expect(seen.failures.get(WORK.id)?.operation).toBe("archive"));
      expect(field(WORK.id, "archivedAt")).toBeNull();
      expect(seen.failures.get(WORK.id)?.error.code).toBe("work_locked");
      await act(async () => seen.failures.get(WORK.id)?.dismiss());
      await settle(() => expect(seen.failures.size).toBe(0));
    });
  });

  it("does not let a read that started before a commit hide that commit", async () => {
    const archiveRead = deferred<WorksSnapshot>();
    const renameRead = deferred<WorksSnapshot>();
    vi.mocked(listProjectWorks)
      .mockImplementationOnce(() => archiveRead.promise)
      .mockImplementationOnce(() => renameRead.promise);
    const renamed = { ...WORK, name: "Revised arc" } as Work;
    respond = async (request) => ({
      work: request.method === "PATCH" ? renamed : archived(SECOND),
    });
    await withProbe(snapshot([WORK, SECOND]), async () => {
      await act(async () => {
        void commands.archive({ workId: SECOND.id });
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(1));
      await act(async () => {
        void commands.update({ workId: WORK.id, data: { name: "Revised arc" } });
      });
      await settle(() => expect(listProjectWorks).toHaveBeenCalledTimes(2));

      await act(async () => archiveRead.resolve(snapshot([WORK, archived(SECOND)], "2")));
      await settle(() => {
        expect(field(SECOND.id, "archivedAt")).not.toBeNull();
        expect(field(WORK.id, "name")).toBe("Revised arc");
      });

      await act(async () => renameRead.resolve(snapshot([renamed, archived(SECOND)], "3")));
      await settle(() => expect(driver.getSnapshot().records.every((r) => r.observed)).toBe(true));
      expect(field(WORK.id, "name")).toBe("Revised arc");
      expect(field(SECOND.id, "archivedAt")).not.toBeNull();
      const shown = renders.findIndex((render) => render.works?.[0]?.name === "Revised arc");
      expect(renders.slice(shown).map((render) => render.works?.[0]?.name)).not.toContain("Arc");
    });
  });

  it("keeps a committed change showing when the read after it fails, until a later read lands", async () => {
    respond = async () => ({ work: archived(WORK) });
    vi.mocked(listProjectWorks).mockRejectedValue(new Error("Offline"));
    await withProbe(snapshot([{ ...WORK, name: "Revised arc" } as Work], "2"), async (client) => {
      await act(async () => {
        await commands.archive({ workId: WORK.id });
      });
      await settle(() => expect(field(WORK.id, "archivedAt")).not.toBeNull());
      expect(field(WORK.id, "name")).toBe("Revised arc");
      expect(driver.getSnapshot().records.map((record) => record.observed)).toEqual([false]);

      vi.mocked(listProjectWorks).mockResolvedValue(
        snapshot([{ ...WORK, name: "Revised arc" } as Work], "3"),
      );
      await act(async () => {
        await refreshWorksSnapshot(client, PROJECT_ID);
      });
      await settle(() =>
        expect(driver.getSnapshot().records.map((r) => r.observed)).toEqual([true]),
      );
      expect(field(WORK.id, "archivedAt")).toBeNull();
    });
  });

  it("closes a Undo window at once, and a refused Undo reopens it", async () => {
    respond = async (request) => (request.method === "DELETE" ? {} : "refuse");
    vi.mocked(listProjectWorks).mockImplementation(async () =>
      snapshot([{ ...WORK, deletedAt: "2026-09-03T00:00:00.000Z" } as Work], "2"),
    );
    await withProbe(snapshot([WORK]), async (client) => {
      await act(async () => {
        await commands.delete({ workId: WORK.id });
      });
      await settle(() => expect(seen.windows.map((open) => open.workId)).toEqual([WORK.id]));
      await act(async () => {
        await commands.restore({ workId: WORK.id });
      });
      await settle(() => expect(seen.windows.map((open) => open.workId)).toEqual([WORK.id]));
      expect(seen.failures.size).toBe(0);

      await act(async () => closeWorkDeleteWindow(client, driver, PROJECT_ID, WORK.id));
      await settle(() => expect(seen.windows).toEqual([]));
    });
  });
});

describe("Work creation", () => {
  const CREATED = {
    ...WORK,
    id: "00000000-0000-4000-8000-000000000003",
    name: "Draft three",
    handle: "w3",
  } as Work;
  const CREATED_ID = CREATED.id as ParsedRequestId;

  it("keeps a confirmed Work in every reader until a read includes it", async () => {
    const post = deferred<{ work: Work }>();
    respond = () => post.promise;
    const refresh = deferred<WorksSnapshot>();
    vi.mocked(listProjectWorks).mockImplementation(() => refresh.promise);
    await withProbe(snapshot([WORK]), async (client) => {
      const staleRead = deferred<WorksSnapshot>();
      const stale = acquireWorksSnapshot(client, PROJECT_ID, () => staleRead.promise);
      await act(async () => {
        void commands.create({ workId: CREATED_ID, draftId: "createdraft1", name: "Draft three" });
      });
      await settle(() => expect(seen.creations.get(CREATED.id)?.phase).toBe("pending"));
      expect(seen.works?.map((work) => work.id)).toEqual([WORK.id]);

      await act(async () => post.resolve({ work: CREATED }));
      await settle(() => expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]));
      const confirmed = renders.length - 1;
      expect(seen.creations.size).toBe(0);

      await act(async () => {
        staleRead.resolve(snapshot([WORK], "2"));
        await stale;
      });
      await act(async () => refresh.resolve(snapshot([CREATED, WORK], "3")));
      await settle(() => expect(driver.getSnapshot().records.every((r) => r.observed)).toBe(true));
      expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]);
      for (const render of renders.slice(confirmed))
        expect(render.works?.map((work) => work.id)).toContain(CREATED.id);
    });
  });

  it("shows a refused Work as not created, and a retry creates it", async () => {
    respond = async () => "refuse";
    let server = snapshot([WORK]);
    vi.mocked(listProjectWorks).mockImplementation(async () => server);
    await withProbe(server, async () => {
      await act(async () => {
        void commands.create({ workId: CREATED_ID, draftId: "createdraft1", name: "Draft three" });
      });
      await settle(() => expect(seen.creations.get(CREATED.id)?.phase).toBe("failed"));
      expect(seen.creations.get(CREATED.id)?.work.name).toBe("Draft three");
      expect(seen.works?.map((work) => work.id)).toEqual([WORK.id]);

      server = snapshot([CREATED, WORK], "2");
      respond = async () => ({ work: CREATED });
      await act(async () => {
        await seen.failures.get(CREATED.id)?.retry();
      });
      await settle(() => expect(seen.works?.map((work) => work.id)).toEqual([CREATED.id, WORK.id]));
      expect(seen.creations.size).toBe(0);
      expect(seen.failures.size).toBe(0);
    });
  });
});
