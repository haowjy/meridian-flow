/** Exact local content access proves cache provenance before exposing an editable Y.Doc. */
import "fake-indexeddb/auto";
import { collabSchemaKeyTag } from "@meridian/prosemirror-schema";
import type { ResourceKey, ResourceRecord } from "@meridian/resource-replica";
import Dexie from "dexie";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalDocumentSessionFactory } from "@/core/editor/document-session-registry";
import type {
  LocalDocumentSessionHandoff,
  LocalDocumentSessionReservationPort,
  LocalDocumentSessionTransfer,
  TransferredDocumentSessionOwnership,
} from "@/core/editor/local-document-session-adoption";
import { DocumentSession, deleteIndexedDb } from "../editor/document-session";
import { IndexedDbResourceMetadata } from "./indexeddb-resource-metadata";
import { ResourceContentAccess, type ResourceContentTransfer } from "./resource-content-access";

const accountId = "content-access-account";
const metadataDatabase = `meridian:resource-metadata:v3:${encodeURIComponent(accountId)}`;
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
      classification: { editable: true, filetype: "markdown", schemaType: "document" },
      canonical: null,
      lifecycle: { kind: "local" },
      aliases: {},
      obligations: { createEligibility: { eligibleAt: 1 } },
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

it("permanently clears exact local content even while an editor lease is open", async () => {
  const metadata = openMetadata();
  const record = resource("delete-local");
  await initialize(record, "words to delete");
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);
  const opened = await access.open("project", key, "editor-tab");
  if (opened.kind !== "opened") throw new Error("Expected local content");

  await access.clearExactContent({
    projectId: "project",
    key,
    documentId: record.resource.identity.documentId,
    databaseName:
      record.resource.content.kind === "exact" ? record.resource.content.databaseName : "",
  });
  opened.handle.release();

  const recreated = createFactory().createDetached({
    accountId,
    projectId: "project",
    documentId: record.resource.identity.documentId,
    persistenceKey:
      record.resource.content.kind === "exact" ? record.resource.content.databaseName : "",
  });
  await recreated.whenLocalPersistenceSynced();
  expect(await recreated.hasInitializedLocalContent()).toBe(false);
  expect(recreated.document.getText("probe").toString()).toBe("");
  await recreated.destroy();
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
    access.open("project", key, "editor-tab-a"),
    access.open("project", key, "editor-tab-b"),
  ]);

  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected both leases");
  expect(first.handle.session).toBe(second.handle.session);
  expect(created).toHaveLength(1);
  first.handle.release();
  expect(second.handle.session.getSnapshot().status).toBe("detached");
  second.handle.release();
  expect(second.handle.session.getSnapshot().status).toBe("destroyed");
});

it("keeps a server-acquired session through navigation until the editor binds it", async () => {
  const metadata = openMetadata();
  const record = resource("server-acquired");
  await initialize(record);
  const key = await install(metadata, record);
  if (record.resource.content.kind !== "exact") throw new Error("Expected exact content");
  const session = createFactory().createDetached({
    accountId,
    projectId: "project",
    documentId: record.resource.identity.documentId,
    persistenceKey: record.resource.content.databaseName,
  });
  await session.whenLocalPersistenceSynced();
  const { access } = openAccess(metadata);
  const release = vi.fn();
  await access.adoptRegistrySession("project", key, session, {
    lease: {
      accountId,
      projectId: "project",
      documentId: record.resource.identity.documentId,
      generation: "7",
    },
    persistenceGeneration: "7",
    exactDatabaseName: record.resource.content.databaseName,
    release,
  });

  const abort = new AbortController();
  const readAccessibleResource = metadata.readAccessibleResource.bind(metadata);
  const read = vi
    .spyOn(metadata, "readAccessibleResource")
    .mockImplementationOnce(async (projectId, resourceKey) => {
      const current = await readAccessibleResource(projectId, resourceKey);
      abort.abort();
      return current;
    });
  await expect(
    access.open("project", key, "cancelled-editor", abort.signal, { adoptionEligible: true }),
  ).resolves.toEqual({ kind: "cancelled" });
  read.mockRestore();
  expect(release).not.toHaveBeenCalled();

  const navigation = await access.open("project", key, "navigation");
  if (navigation.kind !== "opened") throw new Error("Expected navigation content");
  expect(navigation.handle.session).toBe(session);
  navigation.handle.release();
  expect(release).not.toHaveBeenCalled();

  const editor = await access.open("project", key, "editor", undefined, {
    adoptionEligible: true,
  });
  if (editor.kind !== "opened") throw new Error("Expected editor content");
  expect(editor.handle.session).toBe(session);
  editor.handle.release();
  expect(release).toHaveBeenCalledOnce();
  await session.destroy();
});

it("lets server acquisition replace a local construction that has not opened", async () => {
  const metadata = openMetadata();
  const record = resource("acquisition-race");
  await initialize(record);
  const key = await install(metadata, record);
  if (record.resource.content.kind !== "exact") throw new Error("Expected exact content");
  let releaseAuthority!: () => void;
  const authority = new Promise<void>((resolve) => {
    releaseAuthority = resolve;
  });
  const created: DocumentSession[] = [];
  const sessionFactory = createFactory(created);
  sessionFactory.whenAuthorityReady = () => authority;
  const { access } = openAccess(metadata, sessionFactory);
  const opening = access.open("project", key, "navigation");
  const serverSession = new DocumentSession({
    roomKey: record.resource.identity.documentId,
    persistence: { kind: "indexeddb", key: record.resource.content.databaseName },
  });
  await serverSession.whenLocalPersistenceSynced();
  const release = vi.fn();
  const adoption = access.adoptRegistrySession("project", key, serverSession, {
    lease: {
      accountId,
      projectId: "project",
      documentId: record.resource.identity.documentId,
      generation: "7",
    },
    persistenceGeneration: "7",
    exactDatabaseName: record.resource.content.databaseName,
    release,
  });

  releaseAuthority();
  await adoption;
  await expect(opening).resolves.toEqual({ kind: "unavailable", reason: "changed" });
  const editor = await access.open("project", key, "editor", undefined, {
    adoptionEligible: true,
  });
  if (editor.kind !== "opened") throw new Error("Expected acquired editor content");
  expect(editor.handle.session).toBe(serverSession);
  editor.handle.release();
  expect(release).toHaveBeenCalledOnce();
  await serverSession.destroy();
});

it("keeps a failed transfer reserved until the next mounted editor retries", async () => {
  const metadata = openMetadata();
  const record = resource("transfer");
  await initialize(record, "words during adoption");
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);
  const opened = await access.open("project", key, "editor-tab", undefined, {
    adoptionEligible: true,
  });
  if (opened.kind !== "opened") throw new Error("Expected local content");
  const session = opened.handle.session;
  let transfer: LocalDocumentSessionTransfer | undefined;
  const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
  const reservations: LocalDocumentSessionReservationPort = {
    reserve: vi.fn((candidate) => {
      transfer = candidate;
      return handoff;
    }),
    abort: vi.fn(),
  };

  const request: ResourceContentTransfer = {
    projectId: "project",
    key,
    transitionId: "transition",
    documentId: record.resource.identity.documentId,
    identityRevision: record.resource.identity.revision,
    databaseName:
      record.resource.content.kind === "exact" ? record.resource.content.databaseName : "",
  };
  await expect(access.reserveTransfer(request, reservations)).resolves.toEqual({
    kind: "reserved",
    handoff,
  });
  expect(transfer?.session).toBe(session);
  opened.handle.release();
  expect(session.getSnapshot().status).toBe("detached");

  const release = vi.fn();
  const ownership: TransferredDocumentSessionOwnership = {
    lease: {
      accountId,
      projectId: "project",
      documentId: record.resource.identity.documentId,
      generation: "7",
    },
    persistenceGeneration: "7",
    exactDatabaseName: "content:transfer",
    release,
  };
  transfer?.prepareCommit();
  await expect(async () => {
    await transfer?.completeCommit(ownership);
  }).rejects.toThrow("The mounted editor closed during session adoption");

  expect(release).not.toHaveBeenCalled();
  release();

  const reopened = await access.open("project", key, "replacement-editor", undefined, {
    adoptionEligible: true,
  });
  if (reopened.kind !== "opened") throw new Error("Expected replacement editor content");
  expect(reopened.handle.session).toBe(session);
  await expect(access.reserveTransfer(request, reservations)).resolves.toEqual({
    kind: "reserved",
    handoff,
  });
  expect(reservations.reserve).toHaveBeenCalledOnce();
  const retryRelease = vi.fn();
  transfer?.prepareCommit();
  await transfer?.completeCommit({ ...ownership, release: retryRelease });
  reopened.handle.release();

  expect(retryRelease).toHaveBeenCalledOnce();
  expect(session.document.getText("probe").toString()).toBe("words during adoption");
  await session.destroy();
});

it("retires an uncommitted transfer only after its reservation is aborted", async () => {
  const metadata = openMetadata();
  const record = resource("abort-transfer");
  await initialize(record);
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);
  const opened = await access.open("project", key, "editor-tab", undefined, {
    adoptionEligible: true,
  });
  if (opened.kind !== "opened") throw new Error("Expected local content");
  const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
  const reservations: LocalDocumentSessionReservationPort = {
    reserve: vi.fn(() => handoff),
    abort: vi.fn(),
  };
  const identity = record.resource.identity;
  await access.reserveTransfer(
    {
      projectId: "project",
      key,
      transitionId: "transition",
      documentId: identity.documentId,
      identityRevision: identity.revision,
      databaseName:
        record.resource.content.kind === "exact" ? record.resource.content.databaseName : "",
    },
    reservations,
  );

  opened.handle.release();
  expect(opened.handle.session.getSnapshot().status).toBe("detached");
  access.abortTransfer(key, handoff);

  expect(reservations.abort).toHaveBeenCalledWith(handoff);
  await vi.waitFor(() => expect(opened.handle.session.getSnapshot().status).toBe("destroyed"));
});

it("destroys an unsettled transfer once during account close", async () => {
  const metadata = openMetadata();
  const record = resource("close-transfer");
  await initialize(record);
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);
  const opened = await access.open("project", key, "editor-tab", undefined, {
    adoptionEligible: true,
  });
  if (opened.kind !== "opened") throw new Error("Expected local content");
  const session = opened.handle.session;
  const destroy = vi.spyOn(session, "destroy");
  const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
  const reservations: LocalDocumentSessionReservationPort = {
    reserve: vi.fn(() => handoff),
    abort: vi.fn(),
  };
  await access.reserveTransfer(
    {
      projectId: "project",
      key,
      transitionId: "transition",
      documentId: record.resource.identity.documentId,
      identityRevision: record.resource.identity.revision,
      databaseName:
        record.resource.content.kind === "exact" ? record.resource.content.databaseName : "",
    },
    reservations,
  );

  await access.finishClose();

  expect(reservations.abort).toHaveBeenCalledWith(handoff);
  expect(destroy).toHaveBeenCalledOnce();
  expect(session.getSnapshot().status).toBe("destroyed");
});

it("does not expose an account resource outside the requesting project's projection", async () => {
  const metadata = openMetadata();
  const record = resource("private");
  await initialize(record);
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);

  await expect(access.open("other-project", key, "editor-tab")).resolves.toEqual({
    kind: "unavailable",
    reason: "missing",
  });
});

it("shares one User-catalog session across the projects that expose it", async () => {
  const metadata = openMetadata();
  const record = resource("user-shared");
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: null };
  record.intents = [];
  await initialize(record);
  const key = await install(metadata, record);
  const scope = { kind: "user" as const, userId: accountId };
  const entries = [
    {
      kind: "source" as const,
      entryId: "user-source",
      scope,
      scheme: "user" as const,
      name: "User",
      uri: "user://",
    },
    {
      kind: "file" as const,
      entryId: record.resource.identity.documentId,
      scope,
      sourceId: "user-source",
      parentId: "user-source",
      name: "shared.md",
      aliases: [],
      path: ["shared.md"],
      uri: "user://shared.md" as const,
      provisionalName: false,
      editable: true,
      filetype: "markdown" as const,
      schemaType: "document" as const,
    },
  ] as const;
  for (const [index, projectId] of ["project-a", "project-b"].entries()) {
    expect(
      await metadata.commitCatalog({
        expectedRevision: null,
        next: {
          projectId,
          scope,
          revision: 1,
          generation: "generation",
          appliedRevision: "1",
          observedHeadRevision: "1",
          cursor: `cursor-${index}`,
          entries,
          invalidatedEntryIds: [],
        },
        resources: [],
      }),
    ).toBe("committed");
  }
  const created: DocumentSession[] = [];
  const { access } = openAccess(metadata, createFactory(created));

  const [first, second] = await Promise.all([
    access.open("project-a", key, "tab-a"),
    access.open("project-b", key, "tab-b"),
  ]);

  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected content");
  expect(first.handle.session).toBe(second.handle.session);
  expect(created).toHaveLength(1);
  first.handle.release();
  second.handle.release();
});

it("releases every project registry ownership after the final shared-content lease", async () => {
  const metadata = openMetadata();
  const record = resource("registry-shared");
  record.resource.lifecycle = { kind: "acknowledged", availabilityGeneration: null };
  record.intents = [];
  await initialize(record);
  const key = await install(metadata, record);
  const scope = { kind: "user" as const, userId: accountId };
  const entries = [
    {
      kind: "source" as const,
      entryId: "user-source",
      scope,
      scheme: "user" as const,
      name: "User",
      uri: "user://",
    },
    {
      kind: "file" as const,
      entryId: record.resource.identity.documentId,
      scope,
      sourceId: "user-source",
      parentId: "user-source",
      name: "shared.md",
      aliases: [],
      path: ["shared.md"],
      uri: "user://shared.md" as const,
      provisionalName: false,
      editable: true,
      filetype: "markdown" as const,
      schemaType: "document" as const,
    },
  ] as const;
  for (const projectId of ["project-a", "project-b"]) {
    expect(
      await metadata.commitCatalog({
        expectedRevision: null,
        next: {
          projectId,
          scope,
          revision: 1,
          generation: "generation",
          appliedRevision: "1",
          observedHeadRevision: "1",
          cursor: `cursor-${projectId}`,
          entries,
          invalidatedEntryIds: [],
        },
        resources: [],
      }),
    ).toBe("committed");
  }
  const { access } = openAccess(metadata);
  const first = await access.open("project-a", key, "tab-a", undefined, {
    adoptionEligible: true,
  });
  const second = await access.open("project-b", key, "tab-b", undefined, {
    adoptionEligible: true,
  });
  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected content");
  const session = first.handle.session;
  let transfer: LocalDocumentSessionTransfer | undefined;
  const handoff = Object.freeze({}) as LocalDocumentSessionHandoff;
  await access.reserveTransfer(
    {
      projectId: "project-a",
      key,
      transitionId: "transition",
      documentId: record.resource.identity.documentId,
      identityRevision: record.resource.identity.revision,
      databaseName: session.persistenceName ?? "",
    },
    {
      reserve(candidate) {
        transfer = candidate;
        return handoff;
      },
      abort() {},
    },
  );
  const releaseA = vi.fn();
  const releaseB = vi.fn();
  const ownershipA: TransferredDocumentSessionOwnership = {
    lease: {
      accountId,
      projectId: "project-a",
      documentId: record.resource.identity.documentId,
      generation: "1",
    },
    persistenceGeneration: "1",
    exactDatabaseName: session.persistenceName ?? "",
    release: releaseA,
  };
  transfer?.prepareCommit();
  await transfer?.completeCommit(ownershipA);
  await access.adoptRegistrySession("project-b", key, session, {
    lease: {
      accountId,
      projectId: "project-b",
      documentId: record.resource.identity.documentId,
      generation: "2",
    },
    persistenceGeneration: "2",
    exactDatabaseName: session.persistenceName ?? "",
    release: releaseB,
  });

  first.handle.release();
  expect(releaseA).not.toHaveBeenCalled();
  expect(releaseB).not.toHaveBeenCalled();
  second.handle.release();
  expect(releaseA).toHaveBeenCalledOnce();
  expect(releaseB).toHaveBeenCalledOnce();
});

it("applies a remint observed by another content owner without replacing either Y.Doc", async () => {
  const metadata = openMetadata();
  const record = resource("remint");
  await initialize(record, "same words");
  const key = await install(metadata, record);
  const firstAccess = openAccess(metadata).access;
  const secondAccess = openAccess(metadata).access;
  const first = await firstAccess.open("project", key, "first");
  const second = await secondAccess.open("project", key, "second");
  if (first.kind !== "opened" || second.kind !== "opened") throw new Error("Expected content");
  const firstDocument = first.handle.session.document;
  const secondDocument = second.handle.session.document;
  const createIntent = record.intents[0];
  if (!createIntent) throw new Error("Expected create intent");
  const oldDocumentId = record.resource.identity.documentId;
  const nextDocumentId = "document-reminted";
  const prepared = firstAccess.prepareReidentity(key, oldDocumentId, nextDocumentId, 2);
  const reminted: ResourceRecord = {
    resource: {
      ...record.resource,
      revision: 2,
      identity: { documentId: nextDocumentId, revision: 2 },
      aliases: {
        [oldDocumentId]: {
          introducedAtIdentityRevision: 2,
        },
      },
    },
    intents: [
      { ...createIntent, state: "cancelled" },
      {
        ...createIntent,
        intentId: "retry",
        sequence: 2,
        identityRevision: 2,
      },
    ],
  };
  expect(
    await metadata.commitResource({ expectedRevision: record.resource.revision, next: reminted }),
  ).toBe("committed");
  prepared?.commit();
  secondAccess.reconcileMetadata(reminted);

  expect(first.handle.session.documentId).toBe(nextDocumentId);
  expect(second.handle.session.documentId).toBe(nextDocumentId);
  expect(first.handle.session.document).toBe(firstDocument);
  expect(second.handle.session.document).toBe(secondDocument);
  expect(second.handle.session.document.getText("probe").toString()).toBe("same words");
  first.handle.release();
  second.handle.release();
});

it("converges to a competing remint observed while its own reidentity is prepared", async () => {
  const metadata = openMetadata();
  const record = resource("competing-remint");
  await initialize(record, "same words");
  const key = await install(metadata, record);
  const { access } = openAccess(metadata);
  const opened = await access.open("project", key, "editor");
  if (opened.kind !== "opened") throw new Error("Expected content");
  const document = opened.handle.session.document;
  const createIntent = record.intents[0];
  if (!createIntent) throw new Error("Expected create intent");
  const oldDocumentId = record.resource.identity.documentId;
  const prepared = access.prepareReidentity(key, oldDocumentId, "losing-document", 2);
  const winner: ResourceRecord = {
    resource: {
      ...record.resource,
      revision: 2,
      identity: { documentId: "winning-document", revision: 2 },
      aliases: { [oldDocumentId]: { introducedAtIdentityRevision: 2 } },
    },
    intents: [{ ...createIntent, identityRevision: 2 }],
  };

  access.reconcileMetadata(winner);
  prepared?.abort();

  expect(opened.handle.session.documentId).toBe("winning-document");
  expect(opened.handle.session.document).toBe(document);
  expect(opened.handle.session.document.getText("probe").toString()).toBe("same words");
  opened.handle.release();
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
      "/old": { introducedAtIdentityRevision: 1 },
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
  const native = metadata.readAccessibleResource.bind(metadata);
  let reads = 0;
  let completeValidation!: () => void;
  const validation = new Promise<void>((resolve) => {
    completeValidation = resolve;
  });
  vi.spyOn(metadata, "readAccessibleResource").mockImplementation(async (projectId, input) => {
    reads++;
    const result = await native(projectId, input);
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
  const native = metadata.readAccessibleResource.bind(metadata);
  let reads = 0;
  vi.spyOn(metadata, "readAccessibleResource").mockImplementation(async (projectId, input) => {
    reads++;
    if (reads === 2) throw new Error("validation unavailable");
    return native(projectId, input);
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
