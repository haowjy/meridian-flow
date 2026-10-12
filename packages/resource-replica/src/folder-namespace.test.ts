/** Folder-journal regressions: refused queues, foreign moves and refresh ownership. */
import type { CatalogEntry, ContextOperationReceipt } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import {
  catalogViewFromSnapshot,
  type FolderNamespaceRecord,
  type FolderNamespaceStore,
  type FolderNamespaceWrite,
  folderObservationFence,
  folderOwnsDeletion,
  type NamespaceOutcome,
  planFolderCatalogInstallation,
  planFolderDeletion,
  planFolderLocation,
  projectFolderCatalog,
  projectFolderLocation,
  projectFolderNeedsRepair,
  type ResourceLocation,
  type ResourceNamespaceTransport,
  reconcileFolderNamespace,
  validateFolderNamespaceUpdate,
} from "./index";

const source: ResourceLocation = { scheme: "manuscript", path: "/A", name: "A", workId: null };
class MemoryFolders implements FolderNamespaceStore {
  readonly accountId = "account";
  record: FolderNamespaceRecord | null = null;
  async readFolder() {
    return this.record && structuredClone(this.record);
  }
  async readFolders(): Promise<readonly FolderNamespaceRecord[]> {
    throw new Error("Not used by reconciliation");
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
function command(store: MemoryFolders, name: string, operationId = name) {
  const write = planFolderLocation({
    record: store.record,
    projectId: "project",
    handle: "folder",
    folderId: "folder",
    source,
    destination: {
      parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
      name: name,
    },
    intentId: operationId,
    operationId,
  });
  if (!write) throw new Error("Missing command");
  return store.commitFolder(write);
}
function receipt(name: string, ok: boolean, operationId = name): ContextOperationReceipt {
  return {
    observationVersion: "1",
    operationId,
    command: {
      destinationParent: {
        kind: "root" as const,
        scheme: "manuscript" as const,
        owner: { workId: null },
      },
      kind: "move",
      sourceUri: "manuscript://A",
      destinationUri: `manuscript://${name}`,
      expected: { kind: "folder", nodeId: "folder" },
    },
    result: ok
      ? { ok: true, value: { destinationPath: name } }
      : { ok: false, error: { code: "conflict", uri: `manuscript://${name}` } },
  };
}
function reconcile(
  store: MemoryFolders,
  transport: Omit<ResourceNamespaceTransport, "accountId" | "lookupIdentity">,
) {
  return reconcileFolderNamespace({
    key: { handle: "folder" },
    metadata: store,
    transport: {
      ...transport,
      accountId: "account",
      lookupIdentity: async () => {
        throw new Error("Unexpected availability lookup");
      },
    },
    lock: {
      accountId: "account",
      async run(_key, task) {
        return { kind: "acquired", value: await task() };
      },
    },
    newAttemptIds: () => ({ attemptId: "attempt", operationId: "unused" }),
    now: () => 100,
  });
}
function install(store: MemoryFolders, name: string, fenced = store.current()) {
  const scheme = "manuscript";
  const scope = { kind: "project" as const, projectId: "project" };
  const entries: CatalogEntry[] = [
    { kind: "source", entryId: "source", name: "Files", scheme, scope, uri: `${scheme}://` },
    {
      observationVersion: String(store.current().revision),
      kind: "folder",
      entryId: "folder",
      sourceId: "source",
      parentId: "source",
      scope,
      name,
      path: [name],
      uri: `manuscript://${name}`,
      hasChildren: false,
    },
  ];
  return planFolderCatalogInstallation({
    projectId: "project",
    folders: [store.current()],
    view: catalogViewFromSnapshot({
      scope,
      generation: "g",
      headRevision: "1",
      cursor: "c",
      entries,
    }),
    fence: { folders: folderObservationFence([fenced]) },
  });
}

it.each([
  false,
  true,
])("recovers a refused queue (receiptless %s) after reopening", async (receiptless) => {
  const store = new MemoryFolders();
  await command(store, "B");
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let refuse!: (value: NamespaceOutcome) => void;
  const pending = reconcile(store, {
    readOutcome: async () => null,
    submit: async () => {
      started();
      return new Promise((resolve) => {
        refuse = resolve;
      });
    },
  });
  await dispatched;
  await command(store, "C");
  refuse(
    receiptless
      ? {
          kind: "refusal",
          operationId: "B",
          error: {
            code: "work_missing",
            message: "Work not found.",
            source: "system",
            retryable: false,
          },
        }
      : { kind: "operation", receipt: receipt("B", false) },
  );
  expect(await pending).toBe("needs-repair");
  const reopened = new MemoryFolders();
  reopened.record = structuredClone(store.current());
  expect(reopened.current().intents.map((i) => i.state)).toEqual(["needs-repair", "cancelled"]);
  expect(projectFolderLocation(reopened.current())).toEqual(source);
  expect(projectFolderNeedsRepair(reopened.current())).toEqual({
    intentId: "B",
    kind: "set-location",
    name: "C",
    destination: {
      parent: { kind: "root", scheme: "manuscript", owner: { workId: null } },
      name: "C",
    },
  });
  await command(reopened, "C", "repair");
  expect(
    await reconcile(reopened, {
      readOutcome: async () => null,
      submit: async (_project, request) => {
        expect(request).toMatchObject({ body: { path: "A", newName: "C" } });
        return { kind: "operation", receipt: receipt("C", true, "repair") };
      },
    }),
  ).toBe("progressed");
  expect(projectFolderLocation(reopened.current()).name).toBe("C");
  expect(projectFolderNeedsRepair(reopened.current())).toBeNull();
});

it("dispatches despite a foreign catalog move during receipt lookup", async () => {
  const store = new MemoryFolders();
  await command(store, "B");
  expect(
    await reconcile(store, {
      readOutcome: async () => {
        const [write] = install(store, "foreign");
        if (!write) throw new Error("Missing foreign move");
        await store.commitFolder(write);
        return null;
      },
      submit: async (_project, request) => {
        expect(request).toMatchObject({
          body: { path: "A", expected: { kind: "folder", nodeId: "folder" } },
        });
        return { kind: "operation", receipt: receipt("B", false) };
      },
    }),
  ).toBe("needs-repair");
  expect(projectFolderLocation(store.current()).path).toBe("/foreign");
  expect(projectFolderNeedsRepair(store.current())).not.toBeNull();
});

it("retires settled placement only at its fenced canonical refresh", async () => {
  const store = new MemoryFolders();
  await command(store, "B");
  expect(
    await reconcile(store, {
      readOutcome: async () => ({ kind: "operation", receipt: receipt("B", true) }),
      submit: async () => {
        throw new Error("Receipt lookup must recover without redispatch");
      },
    }),
  ).toBe("progressed");
  expect(install(store, "B", { ...store.current(), canonicalRefresh: undefined })).toEqual([]);
  expect(projectFolderLocation(store.current()).path).toBe("/B");
  const [refresh] = install(store, "B");
  if (!refresh) throw new Error("Missing refresh");
  await store.commitFolder(refresh);
  const [follow] = install(store, "foreign");
  if (!follow) throw new Error("Missing canonical follow");
  await store.commitFolder(follow);
  expect(projectFolderLocation(store.current()).path).toBe("/foreign");
});

it("admits recursive deletion in the folder journal and settles a delete receipt", async () => {
  const store = new MemoryFolders();
  const write = planFolderDeletion({
    projectId: "project",
    handle: "folder",
    folderId: "folder",
    source,
    intentId: "delete-folder",
    operationId: "delete-folder",
  });
  if (!write) throw new Error("Missing deletion plan");
  await store.commitFolder(write);
  expect(folderOwnsDeletion(store.current())).toBe(true);
  await reconcile(store, {
    readOutcome: async () => null,
    submit: async (_projectId, request) => {
      expect(request).toMatchObject({
        kind: "delete",
        body: { path: "A", expected: { kind: "folder", nodeId: "folder" } },
      });
      return {
        kind: "operation",
        receipt: {
          observationVersion: "1",
          operationId: "delete-folder",
          command: {
            kind: "delete",
            uri: "manuscript://A",
            expected: { kind: "folder", nodeId: "folder" },
          },
          result: {
            ok: true,
            value: {
              status: "deleted",
              deletedDocumentIds: ["child"],
              availabilityGeneration: "9",
            },
          },
        },
      };
    },
  });
  expect(store.current().intents.at(-1)?.state).toBe("settled");
  expect(folderOwnsDeletion(store.current())).toBe(true);
  expect(store.current().canonicalRefresh).toBeUndefined();
});

// Both receipt-bearing and intake refusals must release deletion admitted during dispatch.
it.each([
  false,
  true,
])("deletes canonical folder after an overlapping move refusal (%s)", async (receiptless) => {
  const store = new MemoryFolders();
  await command(store, "B");
  const outcomes: NamespaceOutcome[] = [];
  await reconcile(store, {
    readOutcome: async () => null,
    submit: async (_project, request) => {
      if (request.kind !== "move") throw new Error("Expected move");
      await command(store, "C");
      const write = planFolderDeletion({
        record: store.current(),
        projectId: "project",
        handle: "folder",
        folderId: "folder",
        source,
        intentId: "delete",
        operationId: "delete",
      });
      if (!write) throw new Error("Missing deletion");
      await store.commitFolder(write);
      const outcome: NamespaceOutcome = receiptless
        ? {
            kind: "refusal",
            operationId: "B",
            error: {
              code: "work_missing",
              message: "Work not found.",
              source: "system",
              retryable: false,
            },
          }
        : { kind: "operation", receipt: receipt("B", false) };
      outcomes.push(outcome);
      return outcome;
    },
  });
  expect(store.current().intents.map((i) => i.state)).toEqual([
    "superseded",
    "cancelled",
    "pending",
  ]);
  expect(store.current().intents[0]?.attempts[0]?.outcome).toEqual(outcomes[0]);
  expect(projectFolderNeedsRepair(store.current())).toBeNull();
  const reopened = new MemoryFolders();
  reopened.record = structuredClone(store.current());
  await reconcile(reopened, {
    readOutcome: async () => null,
    submit: async (_project, request) => {
      expect(request).toMatchObject({
        kind: "delete",
        body: { path: "A", expected: { kind: "folder", nodeId: "folder" } },
      });
      return {
        kind: "operation",
        receipt: {
          observationVersion: "1",
          operationId: "delete",
          command: {
            kind: "delete",
            uri: "manuscript://A",
            expected: { kind: "folder", nodeId: "folder" },
          },
          result: {
            ok: true,
            value: { status: "deleted", deletedDocumentIds: [], availabilityGeneration: "2" },
          },
        },
      };
    },
  });
  expect(reopened.current().intents.map((i) => i.state)).toEqual([
    "superseded",
    "cancelled",
    "settled",
  ]);
});

it.each([
  false,
  true,
])("suppresses the placed subtree when its destination is deleted (delete first %s)", async (deleteFirst) => {
  const moving = new MemoryFolders();
  const deletion = new MemoryFolders();
  const move = planFolderLocation({
    projectId: "project",
    handle: "folder",
    folderId: "folder",
    source,
    intentId: "move",
    operationId: "move",
    destination: { parent: { kind: "folder", folderId: "destination" }, name: "A" },
  });
  const remove = planFolderDeletion({
    projectId: "project",
    handle: "destination",
    folderId: "destination",
    source: { ...source, path: "/B", name: "B" },
    intentId: "delete",
    operationId: "delete",
  });
  if (!move || !remove) throw new Error("Missing commands");
  await moving.commitFolder(move);
  await deletion.commitFolder(remove);
  const scope = { kind: "project" as const, projectId: "project" };
  const entries: CatalogEntry[] = [
    {
      kind: "source",
      entryId: "source",
      name: "Files",
      scheme: "manuscript",
      scope,
      uri: "manuscript://",
    },
    ...[
      ["folder", "A"],
      ["destination", "B"],
    ].map(([entryId, name]) => ({
      observationVersion: "1",
      kind: "folder" as const,
      entryId,
      name,
      sourceId: "source",
      parentId: "source",
      scope,
      path: [name],
      uri: `manuscript://${name}`,
      hasChildren: true,
    })),
    {
      observationVersion: "1",
      kind: "folder",
      entryId: "child",
      name: "Child",
      sourceId: "source",
      parentId: "folder",
      scope,
      path: ["A", "Child"],
      uri: "manuscript://A/Child",
      hasChildren: false,
    },
    {
      observationVersion: "1",
      kind: "file",
      entryId: "document",
      name: "doc.md",
      sourceId: "source",
      parentId: "child",
      scope,
      path: ["A", "Child", "doc.md"],
      uri: "manuscript://A/Child/doc.md",
      aliases: [],
      provisionalName: false,
      editable: true,
      filetype: "markdown",
      schemaType: "document",
    },
  ];
  const folders = deleteFirst
    ? [deletion.current(), moving.current()]
    : [moving.current(), deletion.current()];
  expect(projectFolderCatalog("project", entries, folders).map((e) => e.entryId)).toEqual([
    "source",
  ]);
});
