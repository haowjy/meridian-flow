/** Public folder commands project instantly and retain immutable, expiring settlement evidence. */
import type { CatalogEntry, ContextOperationReceipt } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import {
  type CatalogCacheView,
  type FolderNamespaceRecord,
  type FolderNamespaceStore,
  type FolderNamespaceWrite,
  folderObservationFence,
  indexCatalogView,
  installFolderCanonicalRefresh,
  planFolderCatalogInstallation,
  planFolderLocation,
  projectFolderCatalog,
  projectFolderLocation,
  projectFolderNeedsRepair,
  type ResourceLocation,
  type ResourceNamespaceTransport,
  rebaseFolderResourceLocation,
  reconcileFolderNamespace,
  settledNamespaceReceipt,
  validateFolderNamespaceUpdate,
} from "./index";

const source: ResourceLocation = {
  scheme: "manuscript",
  path: "/chapters",
  name: "chapters",
  workId: null,
};
const destination = {
  scheme: "manuscript" as const,
  folderPath: "/volume",
  name: "renamed",
  workId: null,
};

class MemoryFolders implements FolderNamespaceStore {
  readonly accountId = "account";
  record: FolderNamespaceRecord | null = null;
  async readFolder() {
    return this.record && structuredClone(this.record);
  }
  async readFolders(projectId: string) {
    return this.record && (this.record.projectId === null || this.record.projectId === projectId)
      ? [structuredClone(this.record)]
      : [];
  }
  async commitFolder(write: FolderNamespaceWrite) {
    if (write.expectedRevision !== (this.record?.revision ?? null)) return "stale" as const;
    validateFolderNamespaceUpdate(this.record, write.next);
    this.record = structuredClone(write.next);
    return "committed" as const;
  }
  current() {
    if (!this.record) throw new Error("Missing folder");
    return this.record;
  }
}

const lock = {
  accountId: "account",
  async run<T>(_key: unknown, task: () => Promise<T>) {
    return { kind: "acquired" as const, value: await task() };
  },
};

function command(record?: FolderNamespaceRecord | null, operationId = "move") {
  const write = planFolderLocation({
    record,
    projectId: "project",
    handle: "folder:chapters",
    folderId: "chapters",
    source,
    destination,
    intentId: operationId,
    operationId,
  });
  if (!write) throw new Error("Missing command");
  return write;
}

function receipt(
  ok: boolean,
  operationId = "move",
  sourceUri = "manuscript://chapters",
  destinationUri = "manuscript://volume/renamed",
): Extract<ContextOperationReceipt, { command: { kind: "move" } }> {
  return {
    operationId,
    command: {
      kind: "move",
      sourceUri,
      destinationUri,
      expected: { kind: "folder", nodeId: "chapters" },
    },
    result: ok
      ? { ok: true, value: { destinationPath: "volume/renamed" } }
      : { ok: false, error: { code: "conflict", uri: "manuscript://volume/renamed" } },
  };
}

function reconcile(store: MemoryFolders, transport: ResourceNamespaceTransport) {
  return reconcileFolderNamespace({
    key: { handle: "folder:chapters" },
    metadata: store,
    transport,
    lock,
    newAttemptIds: () => ({ attemptId: "attempt", operationId: "background-id" }),
    now: () => 100,
  });
}

const entries: readonly CatalogEntry[] = [
  {
    kind: "source",
    entryId: "source",
    scope: { kind: "project", projectId: "project" },
    scheme: "manuscript",
    name: "Manuscript",
    uri: "manuscript://",
  },
  ...[
    ["volume", ["volume"], "source"],
    ["chapters", ["chapters"], "source"],
    ["nested", ["chapters", "nested"], "chapters"],
    ["chapters-extra", ["chapters-extra"], "source"],
  ].map(([id, path, parentId]) => ({
    kind: "folder" as const,
    entryId: id as string,
    scope: { kind: "project" as const, projectId: "project" },
    sourceId: "source",
    parentId: parentId as string,
    name: (path as string[]).at(-1) ?? "",
    path: path as string[],
    uri: `manuscript://${(path as string[]).join("/")}`,
    hasChildren: true,
  })),
  {
    kind: "file",
    entryId: "chapter",
    scope: { kind: "project", projectId: "project" },
    sourceId: "source",
    parentId: "nested",
    name: "one.md",
    path: ["chapters", "nested", "one.md"],
    uri: "manuscript://chapters/nested/one.md",
    aliases: [],
    provisionalName: false,
    editable: true,
    filetype: "markdown",
    schemaType: "document",
  },
];

describe("folder namespace public API", () => {
  it("rebases the folder, nested descendants and readable locations before a receipt arrives", async () => {
    const store = new MemoryFolders();
    await store.commitFolder(command());
    let submitted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    let answer!: (outcome: { kind: "operation"; receipt: ContextOperationReceipt }) => void;
    const dispatch = reconcile(store, {
      accountId: "account",
      readOutcome: async () => null,
      submit: async (_projectId, request) => {
        expect(request).toMatchObject({
          kind: "move",
          body: {
            operationId: "move",
            path: "chapters",
            expected: { kind: "folder", nodeId: "chapters" },
            destinationFolderPath: "volume",
            newName: "renamed",
          },
        });
        submitted();
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    await dispatchStarted;
    const projected = projectFolderCatalog("project", entries, [store.current()]);
    expect(projected.find((entry) => entry.entryId === "chapters")).toMatchObject({
      path: ["volume", "renamed"],
      parentId: "volume",
      name: "renamed",
      uri: "manuscript://volume/renamed",
    });
    expect(projected.find((entry) => entry.entryId === "chapter")).toMatchObject({
      path: ["volume", "renamed", "nested", "one.md"],
      parentId: "nested",
    });
    expect(projected.find((entry) => entry.entryId === "chapters-extra")).toEqual(
      entries.find((entry) => entry.entryId === "chapters-extra"),
    );
    expect(
      rebaseFolderResourceLocation(
        "project",
        { ...source, path: "/chapters/nested/one.md", name: "one.md" },
        [store.current()],
      ).path,
    ).toBe("/volume/renamed/nested/one.md");
    expect(projectFolderCatalog("other-project", entries, [store.current()])).toEqual(entries);
    for (const workSlug of [null, "draft"]) {
      const workDestination = {
        ...destination,
        scheme: "scratch" as const,
        workId: "work",
        workSlug,
      };
      const workMove = planFolderLocation({
        projectId: "project",
        handle: "folder:chapters",
        folderId: "chapters",
        source,
        destination: workDestination,
        intentId: "work-move",
        operationId: "work-move",
      });
      if (!workMove) throw new Error("Missing Work move");
      const workEntries: readonly CatalogEntry[] = [
        ...entries,
        {
          kind: "source",
          entryId: "scratch-source",
          scope: { kind: "work", projectId: "project", workId: "work" },
          scheme: "scratch",
          name: "Scratch",
          uri: workSlug ? "scratch://@draft/" : "scratch://@/",
        },
        {
          kind: "folder",
          entryId: "work-volume",
          sourceId: "scratch-source",
          parentId: "scratch-source",
          scope: { kind: "work", projectId: "project", workId: "work" },
          name: "volume",
          path: ["volume"],
          uri: workSlug ? "scratch://@draft/volume" : "scratch://@/volume",
          hasChildren: true,
        },
      ];
      const workProjection = projectFolderCatalog("project", workEntries, [workMove.next]);
      expect(workProjection.find((entry) => entry.entryId === "chapters")).toMatchObject({
        sourceId: "scratch-source",
        parentId: "work-volume",
        scope: { kind: "work", workId: "work" },
      });
      expect(workProjection.find((entry) => entry.entryId === "chapter")).toMatchObject({
        sourceId: "scratch-source",
        parentId: "nested",
        uri: `scratch://@${workSlug ?? ""}/volume/renamed/nested/one.md`,
      });
    }

    expect(() =>
      planFolderLocation({
        record: store.current(),
        projectId: "project",
        handle: "folder:chapters",
        folderId: "chapters",
        source,
        destination: { ...destination, folderPath: "/volume/renamed" },
        intentId: "cycle",
        operationId: "cycle",
      }),
    ).toThrow("inside itself");
    answer({ kind: "operation", receipt: receipt(true) });
    expect(await dispatch).toBe("progressed");
    expect(projectFolderLocation(store.current()).path).toBe("/volume/renamed");
    expect(store.current().canonicalRefresh).toEqual({ operationId: "move" });
    const refresh = installFolderCanonicalRefresh(
      store.current(),
      "move",
      projectFolderLocation(store.current()),
    );
    if (!refresh) throw new Error("Missing refresh");
    await store.commitFolder(refresh);
    expect(store.current().canonicalRefresh).toBeUndefined();
  });

  it("repairs a rejected move back onto the folder and retries without historical ownership", async () => {
    const store = new MemoryFolders();
    await store.commitFolder(command());
    const rejected = {
      accountId: "account",
      readOutcome: async () => null,
      submit: async () => ({ kind: "operation" as const, receipt: receipt(false) }),
    };
    expect(await reconcile(store, rejected)).toBe("needs-repair");
    expect(projectFolderCatalog("project", entries, [store.current()])).toEqual(entries);
    expect(projectFolderNeedsRepair(store.current())).toEqual({
      intentId: "move",
      name: "renamed",
    });
    expect(settledNamespaceReceipt(store.current().intents, "move", 100)).toEqual(receipt(false));
    await store.commitFolder(command(store.current(), "retry"));
    expect(projectFolderNeedsRepair(store.current())).toBeNull();
    expect(projectFolderLocation(store.current()).path).toBe("/volume/renamed");
    expect(
      await reconcile(store, {
        ...rejected,
        submit: async () => ({ kind: "operation", receipt: receipt(false, "retry") }),
      }),
    ).toBe("needs-repair");
    expect(projectFolderLocation(store.current())).toEqual(source);
    expect(projectFolderCatalog("project", entries, [store.current()])).toEqual(entries);
  });

  it("recovers a refused queue after reopening durable metadata and accepts a different repair", async () => {
    const store = new MemoryFolders();
    await store.commitFolder(command());
    let started!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    let refuse!: (value: { kind: "operation"; receipt: ContextOperationReceipt }) => void;
    const first = reconcile(store, {
      accountId: "account",
      readOutcome: async () => null,
      submit: async () => {
        started();
        return new Promise((resolve) => {
          refuse = resolve;
        });
      },
    });
    await dispatched;
    const queued = planFolderLocation({
      record: store.current(),
      projectId: "project",
      handle: "folder:chapters",
      folderId: "chapters",
      source,
      destination: { ...destination, name: "queued" },
      intentId: "queued",
      operationId: "queued",
    });
    if (!queued) throw new Error("Missing queued command");
    await store.commitFolder(queued);
    refuse({ kind: "operation", receipt: receipt(false) });
    expect(await first).toBe("needs-repair");

    const reopened = new MemoryFolders();
    reopened.record = structuredClone(store.current());
    expect(reopened.current().intents.map((intent) => intent.state)).toEqual([
      "needs-repair",
      "cancelled",
    ]);
    expect(projectFolderLocation(reopened.current())).toEqual(source);
    expect(projectFolderNeedsRepair(reopened.current())?.intentId).toBe("move");
    for (const name of ["renamed", "queued", "chapters"]) {
      const retry = planFolderLocation({
        record: reopened.current(),
        projectId: "project",
        handle: "folder:chapters",
        folderId: "chapters",
        source,
        destination: { ...destination, folderPath: name === "chapters" ? "" : "/volume", name },
        intentId: `retry-${name}`,
        operationId: `retry-${name}`,
      });
      if (!retry) throw new Error("Repair must not be a no-op");
      expect(() => validateFolderNamespaceUpdate(reopened.current(), retry.next)).not.toThrow();
    }
    const repair = planFolderLocation({
      record: reopened.current(),
      projectId: "project",
      handle: "folder:chapters",
      folderId: "chapters",
      source,
      destination: { ...destination, name: "repair" },
      intentId: "repair",
      operationId: "repair",
    });
    if (!repair) throw new Error("Missing repair command");
    await reopened.commitFolder(repair);
    expect(reopened.current().intents.map((intent) => intent.state)).toEqual([
      "settled",
      "cancelled",
      "pending",
    ]);
    expect(
      await reconcile(reopened, {
        accountId: "account",
        readOutcome: async () => null,
        submit: async (_projectId, request) => {
          expect(request).toMatchObject({ body: { path: "chapters", newName: "repair" } });
          return {
            kind: "operation",
            receipt: receipt(true, "repair", "manuscript://chapters", "manuscript://volume/repair"),
          };
        },
      }),
    ).toBe("progressed");
    expect(projectFolderLocation(reopened.current()).name).toBe("repair");
  });

  it("dispatches an identity-bound attempt when a foreign move arrives during receipt lookup", async () => {
    const store = new MemoryFolders();
    await store.commitFolder(command());
    let submissions = 0;
    const scope = { kind: "project", projectId: "project" } as const;
    const result = await reconcile(store, {
      accountId: "account",
      readOutcome: async () => {
        const view = indexCatalogView({
          scope,
          generation: "g",
          appliedRevision: "2",
          observedHeadRevision: "2",
          cursor: "c",
          invalidatedEntryIds: new Set(),
          entries: new Map<string, CatalogEntry>([
            [
              "source",
              {
                kind: "source",
                entryId: "source",
                scope,
                scheme: "manuscript",
                name: "Files",
                uri: "manuscript://",
              },
            ],
            [
              "chapters",
              {
                kind: "folder",
                entryId: "chapters",
                scope,
                sourceId: "source",
                parentId: "source",
                name: "external",
                path: ["external"],
                uri: "manuscript://external",
                hasChildren: false,
              },
            ],
          ]),
        });
        const [write] = planFolderCatalogInstallation({
          projectId: "project",
          folders: [store.current()],
          view,
          fence: { folders: folderObservationFence([store.current()]) },
        });
        if (!write) throw new Error("Missing foreign catalog installation");
        await store.commitFolder(write);
        return null;
      },
      submit: async (_projectId, request) => {
        submissions++;
        expect(request).toMatchObject({
          body: { path: "chapters", expected: { kind: "folder", nodeId: "chapters" } },
        });
        return { kind: "operation", receipt: receipt(false) };
      },
    });
    expect(result).toBe("needs-repair");
    expect(submissions).toBe(1);
    expect(projectFolderLocation(store.current()).path).toBe("/external");
    expect(projectFolderNeedsRepair(store.current())).not.toBeNull();
  });

  it("selects the whole settled receipt by caller operation id and expires without deleting evidence", async () => {
    const store = new MemoryFolders();
    await store.commitFolder(command());
    const fullReceipt = receipt(true);
    // P5's future receipt additions must survive without the replica knowing their schema.
    if (fullReceipt.result.ok)
      Object.assign(fullReceipt.result.value, { linkUpdate: { links: 14, documents: 2 } });
    expect(settledNamespaceReceipt(store.current().intents, "move", 100)).toBeNull();
    expect(
      await reconcile(store, {
        accountId: "account",
        readOutcome: async () => ({ kind: "operation", receipt: fullReceipt }),
        submit: async () => {
          throw new Error("Receipt lookup must recover without redispatch");
        },
      }),
    ).toBe("progressed");
    expect(settledNamespaceReceipt(store.current().intents, "missing", 100)).toBeNull();
    expect(settledNamespaceReceipt(store.current().intents, "move", 4099)).toEqual(fullReceipt);
    expect(settledNamespaceReceipt(store.current().intents, "move", 4100)).toBeNull();
    expect(store.current().intents[0]?.attempts[0]?.outcome).toEqual({
      kind: "operation",
      receipt: fullReceipt,
    });
  });

  it.each([
    "manuscript",
    "user",
  ] as const)("takes %s folder canonical refresh and preserves namespace ownership across projects", async (scheme) => {
    const store = new MemoryFolders();
    const initial = planFolderLocation({
      projectId: "project",
      handle: "folder:chapters",
      folderId: "chapters",
      source: { ...source, scheme },
      destination: { ...destination, scheme },
      intentId: "move",
      operationId: "move",
    });
    if (!initial) throw new Error("Missing initial command");
    await store.commitFolder(initial);
    const settled = await reconcile(store, {
      accountId: "account",
      readOutcome: async () => ({
        kind: "operation",
        receipt: receipt(true, "move", `${scheme}://chapters`, `${scheme}://volume/renamed`),
      }),
      submit: async () => {
        throw new Error("Receipt lookup must recover without redispatch");
      },
    });
    expect(settled).toBe("progressed");
    const scope =
      scheme === "user"
        ? ({ kind: "user", userId: "account" } as const)
        : ({ kind: "project", projectId: "project" } as const);
    const catalogWith = (path: string[]): CatalogCacheView =>
      indexCatalogView({
        scope,
        generation: "generation",
        appliedRevision: "1",
        observedHeadRevision: "1",
        cursor: "cursor",
        invalidatedEntryIds: new Set(),
        entries: new Map(
          [
            {
              kind: "source" as const,
              entryId: "source",
              name: "Files",
              scheme,
              scope,
              uri: `${scheme}://`,
            },
            {
              kind: "folder" as const,
              entryId: "chapters",
              scope,
              sourceId: "source",
              parentId: "source",
              name: path.at(-1) ?? "",
              path,
              uri: `${scheme}://${path.join("/")}`,
              hasChildren: false,
            },
          ].flatMap((entry) => (entry ? [[entry.entryId, entry] as const] : [])),
        ),
      });
    const install = (view: CatalogCacheView, fenced: FolderNamespaceRecord) =>
      planFolderCatalogInstallation({
        projectId: "project",
        folders: [store.current()],
        view,
        fence: { folders: folderObservationFence([fenced]) },
      });

    // A read begun before the receipt cannot clear the barrier it never saw.
    expect(
      install(catalogWith(["volume", "renamed"]), {
        ...store.current(),
        canonicalRefresh: undefined,
      }),
    ).toEqual([]);
    const [refresh] = install(catalogWith(["volume", "renamed"]), store.current());
    if (!refresh) throw new Error("Missing refresh");
    await store.commitFolder(refresh);
    expect(store.current().canonicalRefresh).toBeUndefined();
    expect(store.current().canonical.path).toBe("/volume/renamed");

    // The settled move no longer owns placement: someone moving the parent shows through.
    const moved = catalogWith(["elsewhere", "renamed"]);
    const [follow] = install(moved, store.current());
    if (!follow) throw new Error("Missing canonical follow");
    await store.commitFolder(follow);
    expect(store.current().canonical.path).toBe("/elsewhere/renamed");
    if (scheme === "user") {
      const second = planFolderLocation({
        record: store.current(),
        projectId: "project-b",
        handle: "folder:chapters",
        folderId: "chapters",
        source: store.current().canonical,
        destination: { ...destination, scheme, name: "from-b" },
        intentId: "from-b",
        operationId: "from-b",
      });
      if (!second) throw new Error("Missing personal folder command");
      await store.commitFolder(second);
      expect(store.current().projectId).toBeNull();
      expect(await store.readFolders("project")).toHaveLength(1);
      expect(await store.readFolders("project-b")).toHaveLength(1);
      expect(
        rebaseFolderResourceLocation("project", store.current().canonical, [store.current()]).name,
      ).toBe("from-b");
      expect(
        rebaseFolderResourceLocation("project-b", store.current().canonical, [store.current()])
          .name,
      ).toBe("from-b");
      expect(
        await reconcile(store, {
          accountId: "account",
          readOutcome: async () => null,
          submit: async (projectId) => {
            expect(projectId).toBe("project-b");
            return {
              kind: "operation",
              receipt: receipt(true, "from-b", "user://elsewhere/renamed", "user://volume/from-b"),
            };
          },
        }),
      ).toBe("progressed");
      const refresh = installFolderCanonicalRefresh(
        store.current(),
        "from-b",
        projectFolderLocation(store.current()),
      );
      if (!refresh) throw new Error("Missing personal refresh");
      await store.commitFolder(refresh);
      expect(projectFolderLocation(store.current()).name).toBe("from-b");
      return;
    }
    expect(projectFolderCatalog("project", [...moved.entries.values()], [store.current()])).toEqual(
      [...moved.entries.values()],
    );
  });
});
