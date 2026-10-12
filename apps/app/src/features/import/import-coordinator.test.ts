import type { ImportReport } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportDestination } from "./destination";
import { fakeImportServer } from "./fake-import-server";
import { ImportCoordinator } from "./import-coordinator";
import { displayOf } from "./import-store";
import { buildManifest } from "./manifest";
import type { Selection } from "./selection";

const announced = vi.hoisted(() => [] as string[]);
vi.mock("@/client/stores/thread-store/announcements", () => ({
  announce: (message: string) => announced.push(message),
}));

const destination: ImportDestination = {
  scheme: "kb",
  path: "/",
  uri: "kb://",
  name: "Knowledge Base",
  folderId: null,
};

function vault(): Selection {
  const file = (path: string) => ({
    path,
    file: new File([`# ${path}`], path.split("/").at(-1) ?? path),
  });
  return {
    leftOut: [],
    roots: [
      {
        rootId: 0,
        kind: "folder",
        name: "vault",
        files: [file("Ch 1.md"), file("Ch 2.md"), file("Lore/Sects.md")],
        folders: ["Empty"],
        unreadable: [],
      },
    ],
  };
}

async function settled(coordinator: ImportCoordinator, importId: string) {
  const store = coordinator.store(importId);
  for (let tick = 0; tick < 200; tick += 1) {
    const phase = store.getSnapshot().local?.phase.kind;
    if (phase === "idle" || phase === "not-started") return store;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("import never settled");
}

describe("ImportCoordinator.start", () => {
  it("answers at once with the rows drawn, then plans and uploads in the background", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);

    const first = coordinator.store(importId).getSnapshot();
    expect(server.calls.plan).toBe(0);
    expect(first.local?.rows.map((row) => [row.kind, row.parentPath, row.name])).toEqual(
      expect.arrayContaining([
        ["dir", "/", "vault"],
        ["dir", "/vault", "Empty"],
        ["dir", "/vault", "Lore"],
        ["file", "/vault", "Ch 1"],
        ["file", "/vault/Lore", "Sects"],
      ]),
    );
    expect(displayOf(first)).toBe("preparing");

    const store = await settled(coordinator, importId);
    expect(server.calls.plan).toBe(1);
    expect(server.calls.send.flat().sort()).toEqual([0, 1, 2]);
    expect(store.getSnapshot().report?.summary.state).toBe("finished");
    expect(displayOf(store.getSnapshot())).toBe("finished");
  });

  it("fails one file alone, shows needs-attention, and Retry lands it", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);

    const state = store.getSnapshot();
    expect([...(state.local?.failures.keys() ?? [])]).toEqual([1]);
    expect(state.report?.entries.get(0)?.state).toBe("landed");
    expect(state.report?.entries.get(2)?.state).toBe("landed");
    expect(displayOf(state)).toBe("needs-attention");

    server.setFailSend(() => false);
    coordinator.retry(importId, [1]);
    expect(displayOf(store.getSnapshot())).toBe("importing");
    await settled(coordinator, importId);
    expect(store.getSnapshot().report?.entries.get(1)?.state).toBe("landed");
    expect(store.getSnapshot().local?.failures.size).toBe(0);
  });

  it("shows didn't-start when the plan is refused, and tries again with the same id", async () => {
    const server = fakeImportServer();
    let refuse = true;
    const plan = server.api.plan;
    server.api.plan = async (...args) => {
      if (refuse) throw new ImportRequestError(413, "too_many_files", { limit: 10000 }, "refused");
      return plan(...args);
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("didnt-start");

    refuse = false;
    coordinator.tryAgain(importId);
    await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("finished");
  });
});

describe("ImportCoordinator.stop", () => {
  it("ends locally when nothing was sent", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    expect(await coordinator.stop(importId)).toBe("nothing-sent");
    expect(server.calls.finish).toBe(0);
    expect(coordinator.store(importId).getSnapshot().local?.rows).toEqual([]);
  });

  it("finishes with what landed and says Couldn't stop when the finish fails", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    const store = await settled(coordinator, importId);
    const finish = server.api.finish;
    server.api.finish = async () => {
      throw new ImportRequestError(0, null, undefined, "offline");
    };
    expect(await coordinator.stop(importId)).toBe("failed");
    expect(displayOf(store.getSnapshot())).toBe("couldnt-stop");
    server.api.finish = finish;
    expect(await coordinator.stop(importId)).toBe("stopped");
    expect(displayOf(store.getSnapshot())).toBe("finished");
    expect(store.getSnapshot().report?.summary.counts.notImported).toBe(1);
  });
});

/** A report the server holds for an import another tab started: one file still arriving. */
function serverReport(): ImportReport {
  return {
    importId: "elsewhere",
    state: "ready",
    destination: { folderUri: "kb://", folderId: null },
    sort: false,
    counts: {
      total: 1,
      landed: 0,
      failed: 0,
      arriving: 1,
      deleted: 0,
      notImported: 0,
      skipped: 0,
      findings: 0,
    },
    lastActivityAt: "2000-01-01T00:00:00.000Z",
    version: "1",
    dismissedAt: null,
    roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: null, uri: null }],
    entries: [],
  };
}

describe("ImportCoordinator.stop on an import this tab does not hold", () => {
  it("shows stopping, then Couldn't stop, then finishes when tried again", async () => {
    const server = fakeImportServer();
    let refuse!: (error: Error) => void;
    server.api.finish = () =>
      new Promise((_resolve, reject) => {
        refuse = reject;
      });
    const coordinator = new ImportCoordinator("p", server.api);
    const store = coordinator.store("elsewhere");
    store.installReport(serverReport());
    expect(displayOf(store.getSnapshot())).toBe("paused");

    const stopping = coordinator.stop("elsewhere");
    expect(displayOf(store.getSnapshot())).toBe("stopping");
    await Promise.resolve();
    refuse(new ImportRequestError(0, null, undefined, "offline"));
    expect(await stopping).toBe("failed");
    expect(displayOf(store.getSnapshot())).toBe("couldnt-stop");

    server.api.finish = async () => ({
      ...serverReport(),
      state: "finished",
      version: "2",
      counts: { ...serverReport().counts, arriving: 0, notImported: 1 },
    });
    expect(await coordinator.stop("elsewhere")).toBe("stopped");
    expect(displayOf(store.getSnapshot())).toBe("finished");
    coordinator.dispose();
  });

  it("does not announce Import stopped when the stop is refused", async () => {
    announced.length = 0;
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    await settled(coordinator, importId);
    server.api.finish = async () => {
      throw new ImportRequestError(0, null, undefined, "offline");
    };
    announced.length = 0;
    expect(await coordinator.stop(importId)).toBe("failed");
    expect(announced).not.toContain("Import stopped.");
    coordinator.dispose();
  });
});

describe("ImportCoordinator.stop before anything was sent", () => {
  it("retires the import here: no status row, no reads of an import the server never saw", async () => {
    const server = fakeImportServer();
    let reads = 0;
    server.api.report = async () => {
      reads += 1;
      throw new ImportRequestError(404, "import_not_found", undefined, "missing");
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(vault(), destination);
    expect(coordinator.getSnapshot().ids).toContain(importId);

    expect(await coordinator.stop(importId)).toBe("nothing-sent");

    const store = coordinator.store(importId);
    expect(coordinator.getSnapshot().ids).not.toContain(importId);
    expect(displayOf(store.getSnapshot())).toBe("finished");
    const stopWatching = store.watch("report");
    await store.refresh();
    stopWatching();
    expect(reads).toBe(0);
    coordinator.dispose();
  });
});

describe("ImportCoordinator.stop while files are still being read", () => {
  it("never sends a plan once Stop has answered that nothing was sent", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const chapter = new File(["writer text"], "Chapter.md");
    const bytes = await chapter.arrayBuffer();
    let release!: () => void;
    chapter.arrayBuffer = () =>
      new Promise((resolve) => {
        release = () => resolve(bytes);
      });
    const importId = coordinator.start(
      {
        leftOut: [],
        roots: [
          {
            rootId: 0,
            kind: "file",
            name: "Chapter.md",
            files: [{ path: "", file: chapter }],
            folders: [],
            unreadable: [],
          },
        ],
      },
      destination,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await coordinator.stop(importId)).toBe("nothing-sent");
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(server.calls.plan).toBe(0);
    const state = coordinator.store(importId).getSnapshot();
    expect(state.local?.phase.kind).toBe("idle");
    expect(displayOf(state)).toBe("finished");
    coordinator.dispose();
  });
});

describe("ImportCoordinator.retry", () => {
  function sixFiles(): Selection {
    return {
      leftOut: [],
      roots: [
        {
          rootId: 0,
          kind: "folder",
          name: "vault",
          files: Array.from({ length: 6 }, (_, index) => ({
            path: `Ch ${index}.md`,
            file: new File([`# Chapter ${index}`], `Ch ${index}.md`),
          })),
          folders: [],
          unreadable: [],
        },
      ],
    };
  }

  it("shares one import's request budget, and Stop cancels every send", async () => {
    const server = fakeImportServer({ failSend: () => true });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = coordinator.start(sixFiles(), destination);
    await settled(coordinator, importId);
    const sends: { entryIds: number[]; signal: AbortSignal }[] = [];
    let open = 0;
    let most = 0;
    server.api.send = (_projectId, _importId, parts, given) => {
      const signal = given ?? new AbortController().signal;
      sends.push({ entryIds: parts.map((part) => part.entryId), signal });
      open += 1;
      most = Math.max(most, open);
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => {
          open -= 1;
          reject(new DOMException("Aborted", "AbortError"));
        }),
      );
    };

    for (let entryId = 0; entryId < 6; entryId += 1) coordinator.retry(importId, [entryId]);
    coordinator.retry(importId, [0]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(most).toBeLessThanOrEqual(3);
    expect(sends.flatMap((send) => send.entryIds).filter((id) => id === 0)).toHaveLength(1);

    void coordinator.stop(importId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends.every((send) => send.signal.aborted)).toBe(true);
    const sent = sends.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends.length).toBe(sent);
    coordinator.dispose();
  });
});

describe("ImportCoordinator.continueImport", () => {
  it("re-sends every file the server wants, including a landing whose claim has lapsed", async () => {
    const server = fakeImportServer();
    const selection = vault();
    const built = await buildManifest(selection, { importId: "crashed", destinationUri: "kb://" });
    await server.api.plan("p", built.manifest);
    // A process crash left two files mid-landing: one claim lapsed, one is still live.
    const [lapsed, live] = [...server.entries.values()].map((entry) => entry.entryId);
    for (const [entryId, wanted] of [
      [lapsed, true],
      [live, false],
    ] as const) {
      const entry = server.entries.get(entryId);
      if (entry) server.entries.set(entryId, { ...entry, state: "landing", wanted });
    }

    const coordinator = new ImportCoordinator("p", server.api);
    const store = coordinator.store("crashed");
    store.installReport(await server.api.report("p", "crashed"));
    await coordinator.continueImport("crashed", built);
    await settled(coordinator, "crashed");

    expect(server.calls.send.flat().sort()).toEqual([lapsed, 2].sort());
    coordinator.dispose();
  });
});
