/** Exact local content access proves cache provenance before exposing an editable Y.Doc. */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type { ResourceKey, ResourceRecord } from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalDocumentSessionFactory } from "@/core/editor/document-session-registry";
import { DocumentSession, deleteIndexedDb } from "../editor/document-session";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { ResourceContentAccess } from "./resource-content-access";

const accountId = "content-access-account";
const metadataDatabase = `meridian:resource-metadata:v1:${encodeURIComponent(accountId)}`;
const databases = new Set<string>();
const stores: IndexedDbResourceMetadata[] = [];
const accesses: ResourceContentAccess[] = [];
const reportedErrors: unknown[] = [];

beforeEach(() => {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", Object.assign(new EventTarget(), { document }));
  vi.stubGlobal("reportError", (error: unknown) => reportedErrors.push(error));
});

function createFactory(created: DocumentSession[] = []): LocalDocumentSessionFactory {
  return {
    whenAuthorityReady: async () => undefined,
    createDetached(input) {
      databases.add(input.persistenceKey);
      const session = new DocumentSession({
        roomKey: input.documentId,
        persistence: {
          kind: "indexeddb",
          key: input.persistenceKey,
          fresh: input.fresh,
        },
      });
      created.push(session);
      return session;
    },
  };
}

function openMetadata() {
  const metadata = new IndexedDbResourceMetadata(accountId, vi.fn());
  stores.push(metadata);
  return metadata;
}

function openAccess(
  metadata: IndexedDbResourceMetadata,
  factory = createFactory(),
  epoch = new AbortController(),
) {
  const access = new ResourceContentAccess(accountId, metadata, factory, epoch.signal);
  accesses.push(access);
  return { access, epoch };
}

function resource(
  handle: string,
  options: {
    databaseName?: string;
    initialization?: "reserved";
    schema?: string | null;
  } = {},
): ResourceRecord {
  const databaseName = options.databaseName ?? `content:${handle}`;
  databases.add(databaseName);
  return {
    resource: {
      handle,
      revision: 1,
      identity: { documentId: `document-${handle}`, revision: 1 },
      content: {
        kind: "exact",
        databaseName,
        schema: options.schema ?? collabSchemaKeyTag(),
        initialization: options.initialization,
      },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: {},
    },
    intents: [
      {
        projectId: "project",
        handle,
        intentId: `create-${handle}`,
        sequence: 1,
        identityRevision: 1,
        desired: { kind: "create", folderPath: "" },
        attempts: [],
        state: "pending",
      },
    ],
  };
}

async function install(metadata: IndexedDbResourceMetadata, record: ResourceRecord) {
  expect(await metadata.commitResource({ expectedRevision: null, next: record })).toBe("committed");
  return record.resource satisfies ResourceKey;
}

async function initialize(record: ResourceRecord, words = "") {
  if (record.resource.content.kind !== "exact") throw new Error("Expected exact content");
  const session = createFactory().createDetached({
    accountId,
    projectId: "project",
    documentId: record.resource.identity.documentId,
    persistenceKey: record.resource.content.databaseName,
    fresh: true,
  });
  await session.whenLocalPersistenceSynced();
  expect(await session.hasInitializedLocalContent()).toBe(true);
  if (words) session.document.getText("probe").insert(0, words);
  await session.destroy();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(accesses.splice(0).map((access) => access.finishClose()));
  await Promise.allSettled(stores.splice(0).map((store) => store.finishClose()));
  await Dexie.delete(metadataDatabase);
  await Promise.all([...databases].map(deleteIndexedDb));
  databases.clear();
  vi.unstubAllGlobals();
  expect(reportedErrors.splice(0)).toEqual([]);
});

it("opens verified local words without waiting for remote admission", async () => {
  const metadata = openMetadata();
  const record = resource("verified");
  await initialize(record, "local words");
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);

  const opened = await access.open("project", key, "editor-tab");

  expect(opened.kind).toBe("opened");
  if (opened.kind !== "opened") throw new Error("Expected local content");
  expect(opened.handle.session.document.getText("probe").toString()).toBe("local words");
  expect(opened.handle.session.getSnapshot().status).toBe("detached");
  opened.handle.release();
});

it("never exposes a blank database without initialization proof", async () => {
  const metadata = openMetadata();
  const key = await install(metadata, resource("unknown"));
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));

  await expect(access.open("project", key, "editor-tab")).resolves.toEqual({
    kind: "unavailable",
    reason: "uninitialized",
  });
  expect(created).toHaveLength(1);
  expect(created[0]?.getSnapshot().status).toBe("destroyed");
});

it("establishes and acknowledges one new exact reservation before exposure", async () => {
  const metadata = openMetadata();
  const record = resource("reserved", { initialization: "reserved" });
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);

  const opened = await access.open("project", key, "editor-tab");

  expect(opened.kind).toBe("opened");
  expect((await metadata.readResource(key))?.resource.content).toEqual({
    kind: "exact",
    databaseName: "content:reserved",
    schema: collabSchemaKeyTag(),
  });
  if (opened.kind === "opened") opened.handle.release();
});

it("keeps independent leases on one same-browser session", async () => {
  const metadata = openMetadata();
  const record = resource("leases");
  await initialize(record);
  const key = await install(metadata, record);
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));

  const [first, second] = await Promise.all([
    access.open("project-a", key, "editor-tab"),
    access.open("project-b", key, "editor-tab"),
  ]);

  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected both leases");
  expect(first.handle.session).toBe(second.handle.session);
  expect(created).toHaveLength(1);
  first.handle.release();
  expect(second.handle.session.getSnapshot().status).toBe("detached");
  second.handle.release();
  expect(second.handle.session.getSnapshot().status).toBe("destroyed");
});

it("shares persisted changes between independent account content owners", async () => {
  const metadata = openMetadata();
  const record = resource("owners");
  await initialize(record);
  const key = await install(metadata, record);
  const first = openAccess(metadata).access;
  const second = openAccess(metadata).access;
  const left = await first.open("project", key, "left-tab");
  const right = await second.open("project", key, "right-tab");
  if (left.kind !== "opened" || right.kind !== "opened") throw new Error("Expected content");

  left.handle.session.document.getText("probe").insert(0, "shared");
  await vi.waitFor(() => {
    expect(right.handle.session.document.getText("probe").toString()).toBe("shared");
  });
  left.handle.release();
  right.handle.release();
});

it.each([
  [
    "schema-mismatch",
    (record: ResourceRecord) => {
      if (record.resource.content.kind === "exact") record.resource.content.schema = "old";
    },
  ],
  [
    "terminal",
    (record: ResourceRecord) => {
      record.resource.lifecycle = { kind: "terminal", generation: "1", transitionId: "delete" };
    },
  ],
] as const)("blocks %s metadata before constructing a session", async (reason, mutate) => {
  const metadata = openMetadata();
  const record = resource(reason);
  mutate(record);
  const key = await install(metadata, record);
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));

  await expect(access.open("project", key, "editor-tab")).resolves.toEqual({
    kind: "unavailable",
    reason,
  });
  expect(created).toHaveLength(0);
});

it("preserves a concurrent metadata update while acknowledging initialization", async () => {
  const metadata = openMetadata();
  const record = resource("cas", { initialization: "reserved" });
  const key = await install(metadata, record);
  const native = metadata.commitResource.bind(metadata);
  let intercept = true;
  vi.spyOn(metadata, "commitResource").mockImplementation(async (write) => {
    if (!intercept || write.expectedRevision !== 1) return native(write);
    intercept = false;
    const concurrent = structuredClone(write.next);
    concurrent.resource.aliases = {
      "/old": { publicationObligationId: "alias", introducedAtIdentityRevision: 1 },
    };
    expect(await native({ expectedRevision: 1, next: concurrent })).toBe("committed");
    return "stale";
  });
  const { access } = openAccess(metadata);

  const opened = await access.open("project", key, "editor-tab");

  expect(opened.kind).toBe("opened");
  expect((await metadata.readResource(key))?.resource.aliases).toHaveProperty("/old");
  if (opened.kind === "opened") opened.handle.release();
});

it("fences new opens on epoch shutdown and retries retained teardown failures", async () => {
  const metadata = openMetadata();
  const record = resource("shutdown");
  await initialize(record);
  const key = await install(metadata, record);
  const created: DocumentSession[] = [];
  const { access, epoch } = openAccess(metadata, createFactory(created));
  const opened = await access.open("project", key, "editor-tab");
  if (opened.kind !== "opened") throw new Error("Expected content");
  const session = opened.handle.session;
  const native = session.destroy.bind(session);
  vi.spyOn(session, "destroy")
    .mockRejectedValueOnce(new Error("blocked close"))
    .mockRejectedValueOnce(new Error("blocked close"))
    .mockImplementation(native);

  epoch.abort();
  await expect(access.open("project", key, "late-tab")).resolves.toEqual({ kind: "cancelled" });
  await expect(access.finishClose()).rejects.toThrow("blocked close");
  await expect(access.finishClose()).resolves.toBeUndefined();
  expect(session.getSnapshot().status).toBe("destroyed");
});

it("waits for local authority readiness before constructing exact persistence", async () => {
  const metadata = openMetadata();
  const record = resource("readiness");
  await initialize(record);
  const key = await install(metadata, record);
  let becomeReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    becomeReady = resolve;
  });
  const created: DocumentSession[] = [];
  const factory = createFactory(created);
  factory.whenAuthorityReady = () => ready;
  const { access, epoch } = openAccess(metadata, factory);

  const opening = access.open("project", key, "editor-tab");
  await Promise.resolve();
  expect(created).toHaveLength(0);
  epoch.abort();
  becomeReady();

  await expect(opening).resolves.toEqual({ kind: "cancelled" });
  expect(created).toHaveLength(0);
});

it("rejects a durable session schema fence before exposing content", async () => {
  const metadata = openMetadata();
  const record = resource("fenced");
  await initialize(record);
  const key = await install(metadata, record);
  const factory = createFactory();
  const native = factory.createDetached.bind(factory);
  factory.createDetached = (input) => {
    const session = native(input);
    session.raiseSchemaFence({ reason: "client-superseded" });
    return session;
  };
  const { access } = openAccess(metadata, factory);

  await expect(access.open("project", key, "editor-tab")).resolves.toEqual({
    kind: "unavailable",
    reason: "schema-mismatch",
  });
});

it.each([
  "participant",
  "epoch",
] as const)("does not expose a session when the %s aborts during final validation", async (abortKind) => {
  const metadata = openMetadata();
  const record = resource(`abort-${abortKind}`);
  await initialize(record);
  const key = await install(metadata, record);
  const participant = new AbortController();
  const epoch = new AbortController();
  const { access } = openAccess(metadata, createFactory(), epoch);
  const native = metadata.readResource.bind(metadata);
  let reads = 0;
  let completeValidation!: () => void;
  const validation = new Promise<void>((resolve) => {
    completeValidation = resolve;
  });
  vi.spyOn(metadata, "readResource").mockImplementation(async (input) => {
    reads++;
    const result = await native(input);
    if (reads === 2) await validation;
    return result;
  });

  const opening = access.open("project", key, "editor-tab", participant.signal);
  await vi.waitFor(() => expect(reads).toBe(2));
  if (abortKind === "participant") participant.abort();
  else epoch.abort();
  completeValidation();

  await expect(opening).resolves.toEqual({ kind: "cancelled" });
});

it("releases its lease when final metadata validation fails", async () => {
  const metadata = openMetadata();
  const record = resource("read-error");
  await initialize(record);
  const key = await install(metadata, record);
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));
  const native = metadata.readResource.bind(metadata);
  let reads = 0;
  vi.spyOn(metadata, "readResource").mockImplementation(async (input) => {
    reads++;
    if (reads === 2) throw new Error("validation unavailable");
    return native(input);
  });

  await expect(access.open("project", key, "editor-tab")).rejects.toThrow("validation unavailable");
  expect(created[0]?.getSnapshot().status).toBe("destroyed");
});

it("quarantines an exact database until failed teardown completes", async () => {
  const metadata = openMetadata();
  const record = resource("quarantine");
  await initialize(record);
  const key = await install(metadata, record);
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));
  const first = await access.open("project", key, "first-tab");
  if (first.kind !== "opened") throw new Error("Expected content");
  const session = first.handle.session;
  const native = session.destroy.bind(session);
  vi.spyOn(session, "destroy")
    .mockRejectedValueOnce(new Error("blocked close"))
    .mockRejectedValueOnce(new Error("blocked close"))
    .mockImplementation(native);
  first.handle.release();

  await expect(access.open("project", key, "second-tab")).rejects.toThrow("blocked close");
  expect(created).toHaveLength(1);
  const reopened = await access.open("project", key, "second-tab");
  expect(reopened.kind).toBe("opened");
  expect(created).toHaveLength(2);
  if (reopened.kind === "opened") reopened.handle.release();
});
