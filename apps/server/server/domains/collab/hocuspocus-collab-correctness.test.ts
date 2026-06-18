/**
 * DB-backed collab correctness: stale-schema recovery via server paths, checkpoint
 * head safety, and single-persist local writes through the Hocuspocus seam.
 */
import { Hocuspocus, isTransactionOrigin, type TransactionOrigin } from "@hocuspocus/server";
import type { DocumentId, UserId } from "@meridian/contracts/runtime";
import {
  contextSources,
  createDb,
  type Database,
  documents,
  documentYjsCheckpoints,
  documentYjsUpdates,
  projects,
} from "@meridian/database";
import {
  assertLocalDevPostgresOrExplicitAllow,
  DB_TEST_FIXTURE_USER_ID_PRIMARY,
  resolveDbTestFixtureUserId,
} from "@meridian/database/__test-support__/db-fixtures";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleDocumentAccess } from "../../lib/document-access.js";
import { createDrizzleDocumentStore } from "./adapters/drizzle/document-store.js";
import {
  createMirror,
  encodeState,
  encodeStateVector,
  originColumns,
} from "./domain/yjs-mirror.js";
import { createDocumentSyncService, type DocumentSyncFacade } from "./index.js";
import type { UpdateOrigin } from "./ports/document-sync.js";

const databaseUrl = process.env.DATABASE_URL;
const runDbTests = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

function deriveOrigin(
  transactionOrigin: unknown,
):
  | { source: "connection"; origin: UpdateOrigin }
  | { source: "local"; origin: UpdateOrigin | null }
  | { source: "redis" }
  | { source: "unknown" } {
  if (!isTransactionOrigin(transactionOrigin)) return { source: "unknown" };
  const origin = transactionOrigin as TransactionOrigin;
  if (origin.source === "connection") {
    const userId = origin.connection.context.userId as UserId | undefined;
    return userId
      ? { source: "connection", origin: { type: "user", userId } }
      : { source: "unknown" };
  }
  if (origin.source === "local") {
    return {
      source: "local",
      origin: (origin.context?.origin as UpdateOrigin | undefined) ?? null,
    };
  }
  return { source: "redis" };
}

function createBoundFacade(db: Database): DocumentSyncFacade {
  const facade = createDocumentSyncService({ db, documentAccess: createDrizzleDocumentAccess(db) });
  const hocuspocus = new Hocuspocus({
    yDocOptions: { gc: false, gcFilter: () => true },
    debounce: 0,
    maxDebounce: 0,
    async onLoadDocument({ documentName }) {
      return facade.loadHocuspocusDocument(documentName as DocumentId);
    },
    async onChange({ documentName, update, transactionOrigin, document }) {
      const origin = deriveOrigin(transactionOrigin);
      if (origin.source !== "connection") return;
      facade.persistConnectionUpdate({
        documentId: documentName as DocumentId,
        update,
        origin: origin.origin,
        document,
      });
    },
    async onStoreDocument({ documentName, document }) {
      await facade.storeHocuspocusDocument(documentName as DocumentId, document);
    },
  });
  facade.bindHocuspocus(hocuspocus);
  return facade;
}

describe.skipIf(!runDbTests || !databaseUrl)("hocuspocus collab correctness (postgres)", () => {
  let db: Database;
  let userId: UserId;
  let projectId: string;
  let sourceId: string;
  let documentId: DocumentId;

  beforeEach(async () => {
    assertLocalDevPostgresOrExplicitAllow(databaseUrl);
    db = createDb(databaseUrl as string);
    userId = (await resolveDbTestFixtureUserId(databaseUrl as string, {
      fixtureUserId: DB_TEST_FIXTURE_USER_ID_PRIMARY,
      suite: "hocuspocus-collab-correctness",
    })) as UserId;
    projectId = crypto.randomUUID();
    sourceId = crypto.randomUUID();
    documentId = crypto.randomUUID() as DocumentId;

    await db.insert(projects).values({
      id: projectId,
      userId,
      name: "Collab correctness",
      slug: `collab-correctness-${projectId}`,
    });
    await db.insert(contextSources).values({
      id: sourceId,
      projectId,
      slug: "manuscript",
      name: "Manuscript",
    });
    await db.insert(documents).values({
      id: documentId,
      contextSourceId: sourceId,
      name: "chapter",
      extension: "md",
      markdownProjection: "# Rebuilt from projection",
      fileType: "markdown",
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it("rebuilds stale-schema docs via getOrCreateMirror and clears old yjs rows", async () => {
    const store = createDrizzleDocumentStore(db);
    const staleEntry = createMirror("stale yjs body", "markdown");
    await store.transaction(async (tx) => {
      const seq = await tx.appendUpdate({
        documentId,
        updateData: encodeState(staleEntry),
        ...originColumns({ type: "system" }),
      });
      await tx.upsertHead({
        documentId,
        fragmentName: "prosemirror",
        schemaVersion: COLLAB_SCHEMA_VERSION - 1,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: encodeStateVector(staleEntry),
        latestCheckpointId: null,
      });
      await tx.insertCheckpoint({
        documentId,
        state: encodeState(staleEntry),
        stateVector: encodeStateVector(staleEntry),
        upToSeq: seq,
        reason: "stale",
      });
    });

    const facade = createBoundFacade(db);
    const mirror = await facade.getOrCreateMirror(documentId, "", "markdown");
    expect(mirror.ok).toBe(true);

    const head = await store.getHead(documentId);
    expect(head?.schemaVersion).toBe(COLLAB_SCHEMA_VERSION);

    const [updateCount] = await db
      .select({ count: count() })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));
    expect(updateCount?.count).toBe(1);

    const [checkpointCount] = await db
      .select({ count: count() })
      .from(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    expect(checkpointCount?.count).toBe(0);

    const read = await facade.readAsMarkdown(documentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toContain("Rebuilt from projection");
    }
  });

  it("storeDocument checkpoint preserves latestUpdateSeq when append advances concurrently", async () => {
    const facade = createBoundFacade(db);
    const hocuspocus = new Hocuspocus({
      yDocOptions: { gc: false, gcFilter: () => true },
      debounce: 0,
      maxDebounce: 0,
      async onLoadDocument({ documentName }) {
        return facade.loadHocuspocusDocument(documentName as DocumentId);
      },
      onStoreDocument: ({ documentName, document }) =>
        facade.storeHocuspocusDocument(documentName as DocumentId, document),
    });
    facade.bindHocuspocus(hocuspocus);

    await facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nFirst write",
      origin: { type: "user", actorUserId: userId },
    });

    const connection = await hocuspocus.openDirectConnection(documentId, {
      origin: { type: "user", userId },
    });
    const liveDoc = connection.document;
    if (!liveDoc) throw new Error("expected live document");

    const store = createDrizzleDocumentStore(db);
    const headBeforeStore = await store.getHead(documentId);
    const seqBeforeStore = headBeforeStore?.latestUpdateSeq ?? 0;

    const storePromise = facade.storeHocuspocusDocument(documentId, liveDoc);
    const appendPromise = facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nConcurrent append",
      origin: { type: "user", actorUserId: userId },
    });
    await Promise.all([storePromise, appendPromise]);

    const headAfter = await store.getHead(documentId);
    expect(headAfter?.latestUpdateSeq).toBeGreaterThan(seqBeforeStore);
    expect(headAfter?.latestCheckpointId).not.toBeNull();

    const loaded = await facade.loadHocuspocusDocument(documentId);
    expect(loaded).toBeDefined();
    const read = await facade.readAsMarkdown(documentId);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value).toContain("Concurrent append");
    }

    await connection.disconnect();
  });

  it("persists local facade writes exactly once (onChange local-skip)", async () => {
    const facade = createBoundFacade(db);
    const seeded = await facade.getOrCreateMirror(documentId, "# Chapter", "markdown");
    expect(seeded.ok).toBe(true);

    const [before] = await db
      .select({ count: count() })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));

    await facade.writeDocument({
      documentId,
      markdown: "# Chapter\n\nSingle persist",
      origin: { type: "user", actorUserId: userId },
    });

    const [after] = await db
      .select({ count: count() })
      .from(documentYjsUpdates)
      .where(eq(documentYjsUpdates.documentId, documentId));

    expect(after?.count).toBe((before?.count ?? 0) + 1);
  });
});
