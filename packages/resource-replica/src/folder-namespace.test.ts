/** Folder-journal regressions: refused queues, foreign moves and refresh ownership. */
import type { CatalogEntry, ContextOperationReceipt } from "@meridian/contracts/protocol";
import { expect, it } from "vitest";
import {
  catalogViewFromSnapshot,
  type FolderNamespaceRecord,
  type FolderNamespaceStore,
  type FolderNamespaceWrite,
  folderObservationFence,
  planFolderCatalogInstallation,
  planFolderLocation,
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
    destination: { scheme: "manuscript", folderPath: "", name, workId: null },
    intentId: operationId,
    operationId,
  });
  if (!write) throw new Error("Missing command");
  return store.commitFolder(write);
}
function receipt(name: string, ok: boolean, operationId = name): ContextOperationReceipt {
  return {
    operationId,
    command: {
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
function reconcile(store: MemoryFolders, transport: Omit<ResourceNamespaceTransport, "accountId">) {
  return reconcileFolderNamespace({
    key: { handle: "folder" },
    metadata: store,
    transport: { ...transport, accountId: "account" },
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

it("recovers a refused middle of the queue and offers the latest name after reopening", async () => {
  const store = new MemoryFolders();
  await command(store, "B");
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  let refuse!: (value: { kind: "operation"; receipt: ContextOperationReceipt }) => void;
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
  refuse({ kind: "operation", receipt: receipt("B", false) });
  expect(await pending).toBe("needs-repair");
  const reopened = new MemoryFolders();
  reopened.record = structuredClone(store.current());
  expect(reopened.current().intents.map((i) => i.state)).toEqual(["needs-repair", "cancelled"]);
  expect(projectFolderLocation(reopened.current())).toEqual(source);
  expect(projectFolderNeedsRepair(reopened.current())).toEqual({ intentId: "B", name: "C" });
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
