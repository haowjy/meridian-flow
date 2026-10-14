import type { ImportEntryStatus, ImportStatus, ImportSummary } from "@meridian/contracts";
import { describe, expect, it, vi } from "vitest";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ClientRow } from "./client-rows";
import type { ImportDestination } from "./destination";
import { fakeImportServer } from "./fake-import-server";
import { type CatalogReader, type Clock, ImportCoordinator } from "./import-coordinator";
import { displayOf } from "./import-store";
import { buildManifest } from "./manifest";
import type { Selection } from "./selection";
import { withImportRows } from "./tree-projection";

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

async function until(done: () => boolean) {
  for (let tick = 0; tick < 200 && !done(); tick += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (!done()) throw new Error("never happened");
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

/** Begin an import whose selection is already read; rows are drawn once the read settles. */
function start(coordinator: ImportCoordinator, selection: Selection): string {
  const importId = coordinator.begin(destination, async () => selection);
  if (!importId) throw new Error("coordinator refused begin");
  return importId;
}

describe("ImportCoordinator.begin", () => {
  it("answers at once, draws rows with the plan's ids, then plans and uploads", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());

    const store = coordinator.store(importId);
    expect(server.calls.plan).toBe(0);
    expect(displayOf(store.getSnapshot())).toBe("reading");
    // The rows are drawn before the plan is sent, and the plan's answer replaces them.
    let rows: readonly ClientRow[] = [];
    let drawnWhile: string | null = null;
    store.subscribe(() => {
      const local = store.getSnapshot().local;
      if (rows.length === 0 && local && local.rows.length > 0) {
        rows = local.rows;
        drawnWhile = displayOf(store.getSnapshot());
      }
    });
    await settled(coordinator, importId);
    expect(drawnWhile).toBe("preparing");
    expect(rows.length).toBeGreaterThan(0);
    const root = rows.find((row) => row.name === "vault");
    expect(rows.map((row) => [row.kind, row.name, row.parentId === root?.id])).toEqual(
      expect.arrayContaining([
        ["dir", "vault", false],
        ["dir", "Empty", true],
        ["dir", "Lore", true],
        ["file", "Ch 1", true],
      ]),
    );

    expect(server.calls.plan).toBe(1);
    expect(server.calls.send.flat().sort()).toEqual([0, 1, 2]);
    // The plan's ids are the ones the rows were drawn with.
    expect(server.entries.get(0)?.documentId).toBe(rows.find((row) => row.name === "Ch 1")?.id);
    coordinator.dispose();
  });

  it("fails one file alone, shows needs-attention, and Retry lands it", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
    const store = await settled(coordinator, importId);

    const state = store.getSnapshot();
    expect([...(state.local?.failures.keys() ?? [])]).toEqual([1]);
    expect(state.report?.entries.get(0)?.state).toBe("landed");
    expect(state.report?.entries.get(2)?.state).toBe("landed");
    expect(displayOf(state)).toBe("needs-attention");

    server.setFailSend(() => false);
    await coordinator.retry(importId, [1]);
    expect(displayOf(store.getSnapshot())).toBe("importing");
    await settled(coordinator, importId);
    expect(store.getSnapshot().report?.entries.get(1)?.state).toBe("landed");
    expect(store.getSnapshot().local?.failures.size).toBe(0);
  });

  it("16: a refused plan warns on the root, Try again replays the same id and manifest, Discard is local", async () => {
    const server = fakeImportServer();
    const sent: [string, unknown][] = [];
    let refuse = true;
    const plan = server.api.plan;
    server.api.plan = async (projectId, manifest) => {
      sent.push([manifest.importId, structuredClone(manifest)]);
      if (refuse) throw new ImportRequestError(413, "too_many_files", { limit: 10000 }, "refused");
      return plan(projectId, manifest);
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
    const store = await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("didnt-start");
    expect(store.getSnapshot().local?.phase).toEqual({
      kind: "not-started",
      code: "too_many_files",
    });

    refuse = false;
    coordinator.tryAgain(importId);
    await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("finished");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);

    // A fresh refusal, then Discard: nothing is sent to the server and the run is gone.
    refuse = true;
    const second = start(coordinator, vault());
    await settled(coordinator, second);
    await coordinator.discard(second);
    expect(server.calls.finish).toBe(0);
    expect(coordinator.view(second)).toBeNull();
    coordinator.dispose();
  });

  it("16: a lost plan response is answered by the stored plan, and Discard calls finish", async () => {
    const server = fakeImportServer();
    let lose = true;
    const plan = server.api.plan;
    server.api.plan = async (projectId, manifest) => {
      const answer = await plan(projectId, manifest);
      if (lose) throw new ImportRequestError(0, null, undefined, "no answer");
      return answer;
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
    const store = await settled(coordinator, importId);
    expect(store.getSnapshot().local?.phase).toEqual({ kind: "not-started", code: null });

    lose = false;
    coordinator.tryAgain(importId);
    await settled(coordinator, importId);
    expect(displayOf(store.getSnapshot())).toBe("finished");

    lose = true;
    const second = start(coordinator, vault());
    await settled(coordinator, second);
    await coordinator.discard(second);
    expect(server.calls.finish).toBe(1);
    expect(coordinator.view(second)).toBeNull();
    coordinator.dispose();
  });

  it("shows the destination as reading until the read answers, and abandons an empty read", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    let finishRead!: (selection: Selection | null) => void;
    const importId = coordinator.begin(
      destination,
      () => new Promise<Selection | null>((resolve) => (finishRead = resolve)),
    );
    if (!importId) throw new Error("refused");
    const store = coordinator.store(importId);
    expect(displayOf(store.getSnapshot())).toBe("reading");
    expect(coordinator.isWorking()).toBe(true);
    finishRead(null);
    await until(() => coordinator.view(importId) === null);
    expect(server.calls.plan).toBe(0);
    expect(coordinator.isWorking()).toBe(false);
    coordinator.dispose();
  });

  it("17: unmounting while a big drop is read leaves no store, no run and no request", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    let signal!: AbortSignal;
    let finishRead!: (selection: Selection | null) => void;
    const importId = coordinator.begin(destination, (options) => {
      signal = options.signal;
      return new Promise<Selection | null>((resolve) => (finishRead = resolve));
    });
    expect(importId).not.toBeNull();
    coordinator.dispose();
    expect(signal.aborted).toBe(true);
    finishRead(vault());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(coordinator.getSnapshot().imports).toEqual([]);
    expect(coordinator.isWorking()).toBe(false);
    expect(server.calls.plan + server.calls.finish + server.calls.send.length).toBe(0);
    // A disposed coordinator refuses to begin.
    expect(coordinator.begin(destination, async () => vault())).toBeNull();
  });
});

describe("ImportCoordinator.stop", () => {
  it("ends locally when nothing was sent", async () => {
    const server = fakeImportServer();
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
    expect(await coordinator.stop(importId)).toBe("nothing-sent");
    expect(server.calls.finish).toBe(0);
    expect(coordinator.view(importId)).toBeNull();
  });

  it("finishes with what landed and says Couldn't stop when the finish fails", async () => {
    const server = fakeImportServer({ failSend: (entryId) => entryId === 1 });
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
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
function serverReport(): ImportStatus {
  return {
    importId: "elsewhere",
    state: "ready",
    destination: { folderUri: "kb://", folderId: null },
    counts: {
      total: 1,
      landed: 0,
      failed: 0,
      arriving: 1,
      deleted: 0,
      notImported: 0,
      skipped: 0,
    },
    lastActivityAt: "2000-01-01T00:00:00.000Z",
    version: "1",
    roots: [{ rootId: 0, kind: "file", name: "Ch 1.md", id: null }],
    folders: [],
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
    const importId = start(coordinator, vault());
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
    server.api.status = async () => {
      reads += 1;
      throw new ImportRequestError(404, "import_not_found", undefined, "missing");
    };
    const coordinator = new ImportCoordinator("p", server.api);
    const importId = start(coordinator, vault());
    expect(coordinator.view(importId)).not.toBeNull();

    expect(await coordinator.stop(importId)).toBe("nothing-sent");

    expect(coordinator.view(importId)).toBeNull();
    expect(coordinator.getSnapshot().imports).toEqual([]);
    await coordinator.refreshOpen();
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
    const importId = start(coordinator, {
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
    });
    // An immediate digest leaves only promise continuations after the read, so one
    // macrotask turn runs everything the released read would ever do.
    const digest = vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));

    await until(() => coordinator.store(importId).getSnapshot().local?.phase.kind === "preparing");
    expect(await coordinator.stop(importId)).toBe("nothing-sent");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(digest).toHaveBeenCalled();
    digest.mockRestore();
    expect(server.calls.plan).toBe(0);
    expect(coordinator.view(importId)).toBeNull();
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
    const importId = start(coordinator, sixFiles());
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

    await Promise.all([
      ...Array.from({ length: 6 }, (_, entryId) => coordinator.retry(importId, [entryId])),
      coordinator.retry(importId, [0]),
    ]);

    expect(most).toBeLessThanOrEqual(3);
    expect(
      sends.flatMap((send) => send.entryIds).filter((id) => id === 0).length,
    ).toBeLessThanOrEqual(1);

    void coordinator.stop(importId);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends.every((send) => send.signal.aborted)).toBe(true);
    const sent = sends.length;
    // Aborted sends reject synchronously and back off only for 429, so whatever
    // Stop sets off is promise continuations, all run before the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
    store.installReport(await server.api.status("p", "crashed"));
    await coordinator.continueImport("crashed", built.held);
    await settled(coordinator, "crashed");

    expect(server.calls.send.flat().sort()).toEqual([lapsed, 2].sort());
    coordinator.dispose();
  });

  it("resumes a planning import by id instead of planning it again", async () => {
    const server = fakeImportServer();
    const built = await buildManifest(vault(), { importId: "slow", destinationUri: "kb://" });
    await server.api.plan("p", built.manifest);
    server.calls.plan = 0;
    server.setPlanning(true);
    const coordinator = new ImportCoordinator("p", server.api);
    coordinator.store("slow").installReport(await server.api.status("p", "slow"));
    await coordinator.continueImport("slow", built.held);
    await settled(coordinator, "slow");
    expect(server.calls.resume).toBe(1);
    expect(server.calls.plan).toBe(0);
    expect(server.calls.send.flat().sort()).toEqual([0, 1, 2]);
    coordinator.dispose();
  });

  it("fails a wanted entry it holds no file for, locally and alone", async () => {
    const server = fakeImportServer();
    const built = await buildManifest(vault(), { importId: "partial", destinationUri: "kb://" });
    await server.api.plan("p", built.manifest);
    const held = new Map(built.held);
    held.delete(1);
    const coordinator = new ImportCoordinator("p", server.api);
    const store = coordinator.store("partial");
    store.installReport(await server.api.status("p", "partial"));
    await coordinator.continueImport("partial", held);
    await settled(coordinator, "partial");
    expect(server.calls.send.flat().sort()).toEqual([0, 2]);
    expect(store.getSnapshot().local?.failures.get(1)).toBe("upload_failed");
    coordinator.dispose();
  });

  it("retry reads fresh: a lapsed claim that never moved the version is sent", async () => {
    const server = fakeImportServer();
    const built = await buildManifest(vault(), { importId: "lapse", destinationUri: "kb://" });
    await server.api.plan("p", built.manifest);
    const entry = server.entries.get(1);
    if (entry) server.entries.set(1, { ...entry, state: "landing", wanted: false });
    const coordinator = new ImportCoordinator("p", server.api);
    const store = coordinator.store("lapse");
    store.installReport(await server.api.status("p", "lapse"));
    await coordinator.continueImport("lapse", built.held);
    await settled(coordinator, "lapse");
    expect(server.calls.send.flat()).not.toContain(1);

    // The landing process died: the claim lapses with no version change.
    const stale = server.entries.get(1);
    if (stale) server.entries.set(1, { ...stale, wanted: true });
    await coordinator.retry("lapse", [1]);
    await settled(coordinator, "lapse");
    expect(server.calls.send.flat()).toContain(1);
    coordinator.dispose();
  });
});

function fakeClock(): Clock & { advance(ms: number): void } {
  let current = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => current,
    setTimeout: (run, ms) => {
      timers.set(++next, { at: current + ms, run });
      return next;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        current = due[1].at;
        due[1].run();
      }
      current = target;
    },
  };
}

/** The catalog as the coordinator sees it: ids it holds now, and a way to say it changed. */
function fakeCatalog(): CatalogReader & {
  hold(...ids: string[]): void;
  drop(...ids: string[]): void;
} {
  const held = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    holds: (id) => held.has(id),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hold: (...ids) => {
      for (const id of ids) held.add(id);
      notify();
    },
    drop: (...ids) => {
      for (const id of ids) held.delete(id);
      notify();
    },
  };
}

function binary(entryId: number, state: ImportEntryStatus["state"]): ImportEntryStatus {
  return {
    entryId,
    rootId: 0,
    path: `m${entryId}.png`,
    filename: `m${entryId}.png`,
    size: 1,
    sha256: "a".repeat(64),
    documentId: `m${entryId}`,
    kind: "binary",
    state,
    parentId: "art",
    scheme: "kb",
    name: `m${entryId}`,
    extension: "png",
    reason: state === "failed" ? "upload_failed" : null,
    wanted: state === "planned" || state === "failed",
  };
}

/** A status another tab's import has on the server: folder `art` and the given images. */
function elsewhere(
  importId: string,
  version: number,
  entries: ImportEntryStatus[],
  state: ImportStatus["state"] = "ready",
): ImportStatus {
  const arriving = entries.filter((e) => e.state === "planned" || e.state === "landing").length;
  return {
    importId,
    state,
    destination: { folderUri: "kb://", folderId: null },
    counts: {
      total: entries.length,
      landed: entries.filter((e) => e.state === "landed").length,
      failed: entries.filter((e) => e.state === "failed").length,
      arriving,
      deleted: 0,
      notImported: 0,
      skipped: 0,
    },
    lastActivityAt: "2000-01-01T00:00:00.000Z",
    version: String(version),
    roots: [{ rootId: 0, kind: "folder", name: "Art", id: "art" }],
    folders: [{ id: "art", parentId: null, scheme: "kb", name: "Art", state: "landed" }],
    entries,
  };
}

/** A coordinator over a server whose open list and statuses the test scripts. */
function scripted() {
  const server = fakeImportServer();
  const world = {
    list: [] as ImportSummary[],
    statuses: new Map<string, ImportStatus | "gone">(),
  };
  const read = async (_p: string, id: string) => {
    const status = world.statuses.get(id);
    if (!status || status === "gone")
      throw new ImportRequestError(404, "import_not_found", undefined, "missing");
    return status;
  };
  server.api.listOpen = async () => world.list;
  server.api.status = read;
  server.api.changes = read;
  const catalog = fakeCatalog();
  const clock = fakeClock();
  const coordinator = new ImportCoordinator("p", server.api, catalog, clock);
  /** Make the server say `status` and let this tab take it in. */
  const publish = async (status: ImportStatus) => {
    world.statuses.set(status.importId, status);
    world.list = status.state === "finished" ? [] : [status];
    await coordinator.refreshOpen();
    await coordinator.read(status.importId);
  };
  return { server, world, catalog, clock, coordinator, publish };
}

describe("ImportCoordinator acquisition", () => {
  it("5: after a reload reads failures and indexes documents with no surface mounted", async () => {
    const { coordinator, publish } = scripted();
    await publish(elsewhere("imp", 1, [binary(0, "landing"), binary(1, "failed")]));

    const view = coordinator.view("imp");
    expect(view?.state.report?.entries.get(1)?.state).toBe("failed");
    expect(coordinator.getSnapshot().documents.get("m1")).toEqual({ importId: "imp", entryId: 1 });
    coordinator.dispose();
  });

  it("14: reads by id an import that left the list, and retires it once finished or gone", async () => {
    const { coordinator, publish, world } = scripted();
    await publish(elsewhere("imp", 1, [binary(0, "planned")]));
    world.statuses.set("imp", elsewhere("imp", 2, [binary(0, "not_imported")], "finished"));
    world.list = [];

    await coordinator.refreshOpen();
    await coordinator.read("imp");
    expect(coordinator.view("imp")).toBeNull();

    await publish(elsewhere("two", 1, [binary(0, "planned")]));
    world.statuses.set("two", "gone");
    world.list = [];
    await coordinator.refreshOpen();
    await coordinator.read("two", true);
    expect(coordinator.view("two")).toBeNull();
    coordinator.dispose();
  });

  it("stops throttling the tree once a big finished import retires", async () => {
    const { coordinator, publish, world, catalog } = scripted();
    const many = Array.from({ length: 600 }, (_, index) => binary(index, "planned"));
    await publish(elsewhere("big", 1, many));
    const small = elsewhere("small", 1, [binary(1000, "planned")]);
    world.statuses.set("small", small);
    world.list = [elsewhere("big", 1, many), small];
    await coordinator.refreshOpen();
    await coordinator.read("small");
    // The big import holds the tree back, so the small one is not drawn yet.
    expect(coordinator.getSnapshot().imports.map((item) => item.importId)).toEqual(["big"]);

    catalog.hold("art", ...many.map((entry) => entry.documentId));
    world.statuses.set(
      "big",
      elsewhere(
        "big",
        2,
        many.map((e) => ({ ...e, state: "landed" as const })),
        "finished",
      ),
    );
    world.list = [small];
    await coordinator.refreshOpen();
    await coordinator.read("big", true);
    expect(coordinator.getSnapshot().imports.map((item) => item.importId)).toEqual(["small"]);
    coordinator.dispose();
  });
});

describe("ImportCoordinator seen ids and bridges", () => {
  it("4: bridges a drawn image that lands, then retires when the bridge closes", async () => {
    const { coordinator, publish, catalog, clock } = scripted();
    catalog.hold("art");
    await publish(elsewhere("imp", 1, [binary(0, "planned")]));
    await publish(elsewhere("imp", 2, [binary(0, "landed")], "finished"));

    // Never seen in this catalog: kept drawn for the bridge, not forever.
    expect([...(coordinator.view("imp")?.bridges ?? [])]).toEqual(["m0"]);
    clock.advance(29_000);
    expect(coordinator.view("imp")).not.toBeNull();
    clock.advance(2000);
    expect(coordinator.view("imp")).toBeNull();
    coordinator.dispose();
  });

  it("13: retires at once when the catalog showed everything first and never moves again", async () => {
    const { coordinator, publish, catalog } = scripted();
    catalog.hold("art", "m0");
    await publish(elsewhere("imp", 1, [binary(0, "planned")]));
    await publish(elsewhere("imp", 2, [binary(0, "landed")], "finished"));

    expect(coordinator.view("imp")).toBeNull();
    coordinator.dispose();
  });

  it("13: keeps landed rows drawn until the catalog catches up, then retires", async () => {
    const { coordinator, publish, catalog } = scripted();
    await publish(elsewhere("imp", 1, [binary(0, "planned")]));
    await publish(elsewhere("imp", 2, [binary(0, "landed")], "finished"));
    expect(coordinator.view("imp")?.bridges.has("m0")).toBe(true);

    catalog.hold("m0");
    expect(coordinator.view("imp")).toBeNull();
    coordinator.dispose();
  });

  it("3: never redraws a row the catalog created and lost before the plan answered", async () => {
    const server = fakeImportServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const plan = server.api.plan;
    server.api.plan = async (...args) => {
      await gate;
      return plan(...args);
    };
    const catalog = fakeCatalog();
    const clock = fakeClock();
    const coordinator = new ImportCoordinator("p", server.api, catalog, clock);
    const importId = start(coordinator, vault());
    const store = coordinator.store(importId);
    await until(() => (store.getSnapshot().local?.manifest ?? null) !== null);
    const rows = store.getSnapshot().local?.rows ?? [];
    const root = rows.find((row) => row.name === "vault")?.id as string;
    const chapter = rows.find((row) => row.name === "Ch 1")?.id as string;

    // Created, then deleted, all before the plan answers.
    catalog.hold(root, chapter);
    catalog.drop(root, chapter);
    release();
    await settled(coordinator, importId);

    const view = coordinator.view(importId);
    expect(view?.seen.has(root)).toBe(true);
    expect(view?.bridges.has(root)).toBe(false);
    expect(view?.bridges.has(chapter)).toBe(false);
    const empty = {
      normalized: { entries: new Map() },
      root: { kind: "dir", entryId: "root", parentId: null, name: "KB", path: "/", uri: "" },
      children: () => [],
      findDocument: () => null,
    } as never;
    const names = withImportRows(empty, "kb", view ? [view] : [])
      .children("root")
      .map((node) => node.name);
    expect(names).not.toContain("vault");

    // The other rows are bridged until their bridges close; then the finished run retires.
    expect(view?.bridges.size).toBeGreaterThan(0);
    clock.advance(31_000);
    expect(coordinator.view(importId)).toBeNull();
    coordinator.dispose();
  });

  it("2: bridges the rows it drew when the plan answers before the catalog, until each is seen", async () => {
    const server = fakeImportServer();
    const catalog = fakeCatalog();
    const clock = fakeClock();
    const coordinator = new ImportCoordinator("p", server.api, catalog, clock);
    const importId = start(coordinator, vault());
    const store = await settled(coordinator, importId);
    const rows = store.getSnapshot().local?.rows ?? [];
    const plan = [...(store.getSnapshot().report?.folders.keys() ?? [])];
    const view = () => coordinator.view(importId);
    expect(rows).toEqual([]);
    expect(plan.length).toBeGreaterThan(0);
    expect(view()?.bridges.size).toBeGreaterThan(0);

    const bridged = [...(view()?.bridges ?? [])];
    catalog.hold(...bridged);
    expect(coordinator.view(importId)).toBeNull();
    coordinator.dispose();
  });
});
