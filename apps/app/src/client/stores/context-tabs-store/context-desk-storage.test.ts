import { expect, it } from "vitest";
import { DeviceContextDeskLedger, parseContextDesk } from "./context-desk-storage";

class MemoryStorage {
  value: string | null = null;
  fail = false;
  getItem() {
    return this.value;
  }
  setItem(_key: string, value: string) {
    if (this.fail) throw new Error("quota");
    this.value = value;
  }
  removeItem() {
    this.value = null;
  }
}
const locks = {
  request: async <T>(
    _name: string,
    _options: { mode: "exclusive" },
    callback: () => T | Promise<T>,
  ) => callback(),
};
const localTab = (documentId: string, instance = `tab-${documentId}`) => ({
  kind: "new" as const,
  tabInstanceId: instance,
  documentId,
  name: "Untitled",
  workId: "work",
  lineageHandle: `lineage-${documentId}`,
  identityRevision: 1,
});

it("rebases independent commands from two same-account ledgers", async () => {
  const storage = new MemoryStorage();
  const first = new DeviceContextDeskLedger(storage, "account", locks);
  const second = new DeviceContextDeskLedger(storage, "account", locks);
  await first.apply({ kind: "open", projectId: "one", tab: localTab("A") });
  const result = await second.apply({ kind: "open", projectId: "two", tab: localTab("B") });
  expect(result.kind).toBe("committed");
  expect(Object.keys(result.snapshot.projects).sort()).toEqual(["one", "two"]);
});

it("settles a witnessed availability removal behind an unrelated realm open", async () => {
  const storage = new MemoryStorage();
  const removalRealm = new DeviceContextDeskLedger(storage, "account", locks);
  const otherRealm = new DeviceContextDeskLedger(storage, "account", locks);
  const removed = localTab("delete-me");
  await removalRealm.apply({ kind: "open", projectId: "project", tab: removed });
  await otherRealm.apply({ kind: "open", projectId: "other", tab: localTab("independent") });

  const result = await removalRealm.apply({
    kind: "apply-availability",
    projectId: "project",
    removals: [removed],
    selections: [],
    updates: [],
  });

  expect(result.snapshot.projects.project?.tabs).toEqual([]);
  expect(result.snapshot.projects.other?.tabs[0]?.documentId).toBe("independent");
});

it("makes an old-account realm stale after the durable account reset", async () => {
  const storage = new MemoryStorage();
  const accountA = new DeviceContextDeskLedger(storage, "account-A", locks);
  await accountA.apply({ kind: "open", projectId: "A-project", tab: localTab("A") });
  const staleA = new DeviceContextDeskLedger(storage, "account-A", locks);
  await accountA.apply({
    kind: "reset-account",
    expectedAccountId: "account-A",
    nextAccountId: "account-B",
  });
  const accountB = new DeviceContextDeskLedger(storage, "account-B", locks);
  await accountB.apply({ kind: "open", projectId: "B-project", tab: localTab("B") });

  const result = await staleA.apply({
    kind: "open",
    projectId: "late-A-project",
    tab: localTab("late-A"),
  });

  expect(result.kind).toBe("stale");
  expect(parseContextDesk(storage.value)).toMatchObject({
    accountId: "account-B",
    projects: { "B-project": {} },
  });
});

it("normalizes a tracked Work move in the durable reducer and reloads it", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  const tab = {
    kind: "tracked" as const,
    tabInstanceId: "tab-doc",
    documentId: "doc",
    scheme: "scratch" as const,
    path: "/work/work-1/doc.md",
    name: "Doc",
    workId: "work-1",
    editable: true as const,
    filetype: "markdown" as const,
    schemaType: "document" as const,
  };
  await ledger.apply({ kind: "open", projectId: "project", tab });
  await ledger.apply({
    kind: "select",
    projectId: "project",
    workId: "work-1",
    tabInstanceId: "tab-doc",
  });
  await ledger.apply({ kind: "open", projectId: "project", tab: { ...tab, workId: "work-2" } });

  const reloaded = new DeviceContextDeskLedger(storage, "account", locks);
  expect(reloaded.snapshot().projects.project).toMatchObject({
    tabs: [{ documentId: "doc", workId: "work-2" }],
    selectedTabIdByWork: {},
  });
});

it("installs an exact settled draft that was never durable", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  const result = await ledger.apply({
    kind: "settle-draft",
    projectId: "project",
    disposition: "applied",
    tab: {
      kind: "tracked",
      tabInstanceId: "draft-tab",
      documentId: "draft-document",
      scheme: "manuscript",
      path: "/Draft.md",
      name: "Draft.md",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      draftOnly: true,
      reviewWorkId: "work",
      reviewDraftId: "draft",
      tabInstanceToken: "token",
    },
  });

  expect(result.kind).toBe("committed");
  expect(parseContextDesk(storage.value)?.projects.project?.tabs).toMatchObject([
    { documentId: "draft-document", tabInstanceId: "draft-tab" },
  ]);
  expect(parseContextDesk(storage.value)?.projects.project?.tabs[0]).not.toHaveProperty(
    "draftOnly",
  );
});

it("publishes selected remint atomically and survives reload", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  await ledger.apply({
    kind: "install-local",
    projectId: "project",
    expectedDeskRevision: 0,
    tab: localTab("A", "tab"),
  });
  await ledger.apply({
    kind: "select",
    projectId: "project",
    workId: "work",
    tabInstanceId: "tab",
  });
  const published = await ledger.apply({
    kind: "publish-remint",
    lineageHandle: "lineage-A",
    minimumIdentityRevision: 2,
    documentId: "B",
  });
  expect(published.snapshot.projects.project?.selectedTabIdByWork.work).toBe("B");
  const restored = new DeviceContextDeskLedger(storage, "account", locks);
  expect(restored.snapshot().projects.project?.tabs[0]?.documentId).toBe("B");
  expect(restored.snapshot().projects.project?.selectedTabIdByWork.work).toBe("B");
});

it("fences an account transition before the next account writes", async () => {
  const storage = new MemoryStorage();
  const accountA = new DeviceContextDeskLedger(storage, "account-A", locks);
  await accountA.apply({ kind: "open", projectId: "A-project", tab: localTab("A") });
  await accountA.apply({
    kind: "reset-account",
    expectedAccountId: "account-A",
    nextAccountId: "account-B",
  });
  const accountB = new DeviceContextDeskLedger(storage, "account-B", locks);
  await accountB.apply({ kind: "open", projectId: "B-project", tab: localTab("B") });
  expect(accountB.snapshot()).toMatchObject({
    accountId: "account-B",
    projects: { "B-project": {} },
  });
  expect(accountB.snapshot().projects["A-project"]).toBeUndefined();
});

it("recognizes an already-next-account reset without replacing its desk", async () => {
  const storage = new MemoryStorage();
  const staleA = new DeviceContextDeskLedger(storage, "account-A", locks);
  const accountB = new DeviceContextDeskLedger(storage, "account-B", locks);
  await accountB.apply({ kind: "open", projectId: "B-project", tab: localTab("B") });

  await expect(
    staleA.apply({
      kind: "reset-account",
      expectedAccountId: "account-A",
      nextAccountId: "account-B",
    }),
  ).resolves.toMatchObject({
    kind: "already-committed",
    snapshot: { accountId: "account-B", projects: { "B-project": {} } },
  });
  expect(parseContextDesk(storage.value)?.projects["B-project"]?.tabs[0]?.documentId).toBe("B");
});

it("rejects a reset when the durable desk belongs to a foreign account", async () => {
  const storage = new MemoryStorage();
  const staleA = new DeviceContextDeskLedger(storage, "account-A", locks);
  const accountC = new DeviceContextDeskLedger(storage, "account-C", locks);
  await accountC.apply({ kind: "open", projectId: "C-project", tab: localTab("C") });
  const durableC = storage.value;

  await expect(
    staleA.apply({
      kind: "reset-account",
      expectedAccountId: "account-A",
      nextAccountId: "account-B",
    }),
  ).resolves.toMatchObject({
    kind: "stale",
    snapshot: {
      accountId: "account-C",
      deskRevision: 1,
      projects: { "C-project": {} },
    },
  });
  expect(storage.value).toBe(durableC);
});

it("proves current remint idempotently and delayed publication advances to current authority", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  await ledger.apply({ kind: "open", projectId: "project", tab: localTab("A") });
  await ledger.apply({
    kind: "publish-remint",
    lineageHandle: "lineage-A",
    minimumIdentityRevision: 2,
    documentId: "B",
  });
  expect(
    (
      await ledger.apply({
        kind: "publish-remint",
        lineageHandle: "lineage-A",
        minimumIdentityRevision: 3,
        documentId: "C",
      })
    ).kind,
  ).toBe("committed");
  expect(
    (
      await ledger.apply({
        kind: "publish-remint",
        lineageHandle: "lineage-A",
        minimumIdentityRevision: 3,
        documentId: "C",
      })
    ).kind,
  ).toBe("already-committed");
  expect(ledger.snapshot().projects.project?.tabs[0]).toMatchObject({
    documentId: "C",
    identityRevision: 3,
  });
});

it("settles adoption publication by exact absence after its tab closes", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  await ledger.apply({ kind: "open", projectId: "project", tab: localTab("A", "tab") });
  await ledger.apply({ kind: "close", projectId: "project", tabInstanceId: "tab" });
  const result = await ledger.apply({
    kind: "publish-adoption",
    lineageHandle: "lineage-A",
    adoptionRevision: 2,
    trackedTab: {
      kind: "tracked",
      documentId: "A",
      scheme: "scratch",
      path: "/A.md",
      name: "A",
      workId: "work",
      editable: true,
      filetype: "markdown",
      schemaType: "document",
      origin: "local-untitled",
    },
  });
  expect(result.kind).toBe("not-referenced");
});

it("leaves the prior authority on a storage failure", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  await ledger.apply({ kind: "open", projectId: "project", tab: localTab("A") });
  storage.fail = true;
  await expect(
    ledger.apply({ kind: "close", projectId: "project", tabInstanceId: "tab-A" }),
  ).rejects.toThrow("quota");
  expect(ledger.snapshot().projects.project?.tabs).toHaveLength(1);
});

it("retains a no-Work binary tab and unrelated desk entries across reload", async () => {
  const storage = new MemoryStorage();
  const ledger = new DeviceContextDeskLedger(storage, "account", locks);
  await ledger.apply({ kind: "open", projectId: "project", tab: localTab("local") });
  await ledger.apply({
    kind: "open",
    projectId: "project",
    tab: {
      kind: "viewer",
      documentId: "image",
      scheme: "uploads",
      path: "/Map.png",
      name: "Map.png",
      editable: false,
      fileType: "image",
    },
  });
  const reloaded = new DeviceContextDeskLedger(storage, "account", locks);
  expect(reloaded.snapshot().projects.project?.tabs.map((tab) => tab.documentId)).toEqual([
    "local",
    "image",
  ]);
});
