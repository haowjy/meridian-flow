/**
 * Hocuspocus ownership adapter for collab persistence. It is the only code path
 * that talks to Hocuspocus-owned Y.Docs: load, live local writes, FIFO human
 * persistence, checkpoints, and shutdown drain.
 */
import type { Hocuspocus } from "@hocuspocus/server";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  documentRestorePoints,
  documents,
  documentYjsCheckpoints,
  documentYjsHeads,
  documentYjsUpdates,
} from "@meridian/database";
import { COLLAB_SCHEMA_VERSION, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import type { EventSink } from "../../observability/index.js";
import { emitEvent } from "../../observability/index.js";
import type { DocumentStore } from "../ports/document-store.js";
import type { PersistedUpdate, UpdateOrigin } from "../ports/document-sync.js";
import { touchDocumentActivity, updateMarkdownProjection } from "./document-activity.js";
import { getSchema, markdownToNode, nodeToMarkdown } from "./schemas.js";
import {
  createMirror,
  encodeState,
  encodeStateVector,
  originColumns,
  rebuildMirror,
  YjsDecodeError,
} from "./yjs-mirror.js";

export type HocuspocusRuntime = Pick<
  Hocuspocus,
  | "openDirectConnection"
  | "documents"
  | "flushPendingStores"
  | "closeConnections"
  | "getDocumentsCount"
  | "getConnectionsCount"
>;

export type PersistenceQueueMetric = {
  documentId: string;
  depth: number;
  oldestAgeMs: number;
  dropped: number;
};

export type CollabPersistenceMetrics = {
  queues: PersistenceQueueMetric[];
  liveDocumentCount: number;
  openConnectionCount: number;
};

const DRAIN_MAX_ITERATIONS = 100;
const DRAIN_MAX_MS = 30_000;
const DRAIN_SETTLE_DELAY_MS = 10;

type QueueTask = {
  startedAt: number;
  run: () => Promise<void>;
};

const MAX_QUEUE_DEPTH = 1000;
const MAX_QUEUE_AGE_MS = 30_000;

class PersistenceQueues {
  private readonly queues = new Map<string, QueueTask[]>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly dropped = new Map<string, number>();

  enqueue(documentId: string, task: () => Promise<void>): boolean {
    const queue = this.queues.get(documentId) ?? [];
    const oldest = queue[0];
    if (
      queue.length >= MAX_QUEUE_DEPTH ||
      (oldest && Date.now() - oldest.startedAt > MAX_QUEUE_AGE_MS)
    ) {
      this.dropped.set(documentId, (this.dropped.get(documentId) ?? 0) + 1);
      console.error("collab persistence queue overloaded; dropping update", {
        documentId,
        depth: queue.length,
        oldestAgeMs: oldest ? Date.now() - oldest.startedAt : 0,
      });
      return false;
    }
    queue.push({ startedAt: Date.now(), run: task });
    this.queues.set(documentId, queue);
    void this.drain(documentId);
    return true;
  }

  metrics(): PersistenceQueueMetric[] {
    const now = Date.now();
    const documentIds = new Set([
      ...this.queues.keys(),
      ...this.running.keys(),
      ...this.dropped.keys(),
    ]);
    return [...documentIds].map((documentId) => {
      const queue = this.queues.get(documentId) ?? [];
      return {
        documentId,
        depth: queue.length + (this.running.has(documentId) ? 1 : 0),
        oldestAgeMs: queue[0] ? now - queue[0].startedAt : 0,
        dropped: this.dropped.get(documentId) ?? 0,
      };
    });
  }

  async drainAll(): Promise<void> {
    for (;;) {
      const documentIds = [...new Set([...this.queues.keys(), ...this.running.keys()])];
      if (documentIds.length === 0) return;
      await Promise.all(documentIds.map((documentId) => this.drain(documentId)));
    }
  }

  private drain(documentId: string): Promise<void> {
    const current = this.running.get(documentId);
    if (current) return current;

    const run = (async () => {
      try {
        for (;;) {
          const queue = this.queues.get(documentId);
          const next = queue?.shift();
          if (!next) {
            this.queues.delete(documentId);
            return;
          }
          try {
            await next.run();
          } catch (error) {
            console.error("collab persistence queue task failed", { documentId, error });
          }
        }
      } finally {
        this.running.delete(documentId);
      }
    })();
    this.running.set(documentId, run);
    return run;
  }
}

function schemaTypeForFiletype(filetype: string): "document" | "code" {
  return filetype === "markdown" ? "document" : "code";
}

function readDocAsMarkdown(document: Y.Doc, filetype = "markdown"): string {
  const schemaType = schemaTypeForFiletype(filetype);
  const fragment = document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const root = yXmlFragmentToProseMirrorRootNode(fragment, getSchema(schemaType));
  return nodeToMarkdown(schemaType, root);
}

function writeDocFromMarkdown(document: Y.Doc, filetype: string, markdown: string): void {
  const schemaType = schemaTypeForFiletype(filetype);
  updateYFragment(
    document,
    document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    markdownToNode(schemaType, markdown),
    { mapping: new Map(), isOMark: new Map() },
  );
}

async function resetMirrorRows(db: Database, documentId: DocumentId): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(documentRestorePoints).where(eq(documentRestorePoints.documentId, documentId));
    await tx
      .delete(documentYjsCheckpoints)
      .where(eq(documentYjsCheckpoints.documentId, documentId));
    await tx.delete(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, documentId));
    await tx.delete(documentYjsHeads).where(eq(documentYjsHeads.documentId, documentId));
  });
}

async function resetAndSeedFromMarkdownProjection(input: {
  db: Database;
  store: DocumentStore;
  documentId: DocumentId;
  eventSink?: EventSink;
  schemaMismatch?: { storedSchemaVersion: number };
}): Promise<Uint8Array | undefined> {
  if (input.schemaMismatch && input.eventSink) {
    emitEvent(input.eventSink, {
      level: "warn",
      source: "collab.hocuspocus",
      name: "document.schema_version_mismatch",
      payload: {
        documentId: input.documentId,
        storedSchemaVersion: input.schemaMismatch.storedSchemaVersion,
        currentSchemaVersion: COLLAB_SCHEMA_VERSION,
      },
    });
  }
  await resetMirrorRows(input.db, input.documentId);
  return seedMirrorFromMarkdownProjection({
    db: input.db,
    store: input.store,
    documentId: input.documentId,
  });
}

async function seedMirrorFromMarkdownProjection(input: {
  db: Database;
  store: DocumentStore;
  documentId: DocumentId;
}): Promise<Uint8Array | undefined> {
  const [document] = await input.db
    .select({ markdown: documents.markdownProjection, fileType: documents.fileType })
    .from(documents)
    .where(eq(documents.id, input.documentId))
    .limit(1);
  if (!document) return undefined;
  const entry = createMirror(document.markdown, document.fileType);
  await input.store.transaction(async (tx) => {
    const seq = await tx.appendUpdate({
      documentId: input.documentId,
      updateData: encodeState(entry),
      ...originColumns({ type: "system" }),
    });
    await tx.upsertHead({
      documentId: input.documentId,
      fragmentName: PROSEMIRROR_FRAGMENT_NAME,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      filetype: document.fileType,
      latestUpdateSeq: seq,
      latestStateVector: encodeStateVector(entry),
      latestCheckpointId: null,
    });
  });
  return encodeState(entry);
}

async function appendUpdateAndAdvanceHead(input: {
  store: DocumentStore;
  documentId: string;
  update: Uint8Array;
  origin: UpdateOrigin;
  document: Y.Doc;
  filetype: string;
  autoCheckpointEvery: number;
}): Promise<PersistedUpdate> {
  let updateSeq = 0;
  await input.store.transaction(async (store) => {
    updateSeq = await store.appendUpdate({
      documentId: input.documentId,
      updateData: input.update,
      ...originColumns(input.origin),
    });
    const head = await store.getHead(input.documentId);
    const latestCheckpoint = await store.getLatestCheckpoint(input.documentId);
    const nextHead = {
      documentId: input.documentId,
      fragmentName: PROSEMIRROR_FRAGMENT_NAME,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      filetype: input.filetype,
      latestUpdateSeq: updateSeq,
      latestStateVector: Y.encodeStateVector(input.document),
      latestCheckpointId: head?.latestCheckpointId ?? null,
    };
    await store.upsertHead(nextHead);

    const baseSeq = latestCheckpoint?.upToSeq ?? 0;
    if (updateSeq - baseSeq >= input.autoCheckpointEvery) {
      const checkpointId = await store.insertCheckpoint({
        documentId: input.documentId,
        state: Y.encodeStateAsUpdate(input.document),
        stateVector: Y.encodeStateVector(input.document),
        upToSeq: updateSeq,
        reason: "auto",
      });
      await store.setLatestCheckpointId(input.documentId, checkpointId);
    }
  });
  return { updateSeq, updateData: input.update };
}

export function createHocuspocusCollabAdapter(deps: {
  db: Database;
  store: DocumentStore;
  autoCheckpointEvery: number;
  eventSink?: EventSink;
}) {
  const queues = new PersistenceQueues();
  const inFlightStores = new Set<Promise<void>>();
  let hocuspocus: HocuspocusRuntime | null = null;

  function bind(instance: HocuspocusRuntime): void {
    hocuspocus = instance;
  }

  function runtime(): HocuspocusRuntime {
    if (!hocuspocus) throw new Error("Hocuspocus runtime is not bound");
    return hocuspocus;
  }

  async function filetypeFor(documentId: DocumentId): Promise<string> {
    const head = await deps.store.getHead(documentId);
    if (head) return head.filetype;
    const [document] = await deps.db
      .select({ fileType: documents.fileType })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!document) throw new Error("Document not found");
    return document.fileType;
  }

  async function loadDocument(documentId: DocumentId): Promise<Uint8Array | undefined> {
    try {
      const head = await deps.store.getHead(documentId);
      if (!head) {
        return seedMirrorFromMarkdownProjection({
          db: deps.db,
          store: deps.store,
          documentId,
        });
      }

      if (head.schemaVersion !== COLLAB_SCHEMA_VERSION) {
        return resetAndSeedFromMarkdownProjection({
          db: deps.db,
          store: deps.store,
          documentId,
          eventSink: deps.eventSink,
          schemaMismatch: { storedSchemaVersion: head.schemaVersion },
        });
      }

      const checkpoint = await deps.store.getLatestCheckpoint(documentId);
      const updates = (
        await deps.store.listUpdatesAfter(documentId, checkpoint?.upToSeq ?? 0)
      ).filter((update) => update.seq <= head.latestUpdateSeq);
      const parts = [
        ...(checkpoint ? [checkpoint.state] : []),
        ...updates.map((u) => u.updateData),
      ];
      if (parts.length === 0) return undefined;
      const entry = rebuildMirror(
        head.filetype,
        checkpoint?.state ?? null,
        updates.map((u) => u.updateData),
      );
      return encodeState(entry);
    } catch (error) {
      if (!(error instanceof YjsDecodeError)) throw error;
      return resetAndSeedFromMarkdownProjection({
        db: deps.db,
        store: deps.store,
        documentId,
      });
    }
  }

  function persistConnectionUpdate(input: {
    documentId: DocumentId;
    update: Uint8Array;
    origin: UpdateOrigin;
    document: Y.Doc;
  }): void {
    const accepted = queues.enqueue(input.documentId, async () => {
      await appendUpdateAndAdvanceHead({
        store: deps.store,
        documentId: input.documentId,
        update: input.update,
        origin: input.origin,
        document: input.document,
        filetype: await filetypeFor(input.documentId),
        autoCheckpointEvery: deps.autoCheckpointEvery,
      });
      if (input.origin.type === "user") {
        await touchDocumentActivity(deps.db, input.documentId, undefined, new Date(), {
          touchAllThreadDocuments: true,
        });
      }
    });
    if (!accepted) {
      // The live edit remains in the Hocuspocus doc; checkpoint/projection will
      // still converge, and the dropped count is emitted through metrics.
      return;
    }
  }

  function trackStore<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    inFlightStores.add(tracked);
    tracked.finally(() => inFlightStores.delete(tracked));
    return operation;
  }

  async function storeDocument(documentId: DocumentId, document: Y.Doc): Promise<void> {
    return trackStore(
      (async () => {
        let filetype: string | null = null;
        await deps.store.transaction(async (tx) => {
          const head = await tx.getHead(documentId);
          if (!head) return;
          const checkpointId = await tx.insertCheckpoint({
            documentId,
            state: Y.encodeStateAsUpdate(document),
            stateVector: Y.encodeStateVector(document),
            upToSeq: head.latestUpdateSeq,
            reason: "store",
          });
          await tx.setLatestCheckpointId(documentId, checkpointId);
          filetype = head.filetype;
        });
        if (filetype) {
          await updateMarkdownProjection(
            deps.db,
            documentId,
            readDocAsMarkdown(document, filetype),
            new Date(),
          );
        }
      })(),
    );
  }

  function hasPendingPersistenceWork(): boolean {
    const metrics = collabMetrics();
    return metrics.queues.some((queue) => queue.depth > 0) || inFlightStores.size > 0;
  }

  async function drain(): Promise<void> {
    const startedAt = Date.now();
    for (let iteration = 0; iteration < DRAIN_MAX_ITERATIONS; iteration += 1) {
      await queues.drainAll();
      hocuspocus?.flushPendingStores();
      while (inFlightStores.size > 0) {
        await Promise.all([...inFlightStores]);
      }
      if (!hasPendingPersistenceWork()) {
        return;
      }
      if (Date.now() - startedAt > DRAIN_MAX_MS) {
        console.error("collab drain quiescence timeout", {
          iteration,
          metrics: collabMetrics(),
          inFlightStores: inFlightStores.size,
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, DRAIN_SETTLE_DELAY_MS));
    }
    console.error("collab drain max iterations exceeded", {
      metrics: collabMetrics(),
      inFlightStores: inFlightStores.size,
    });
  }

  async function recoverDocumentFromMarkdownProjection(
    documentId: DocumentId,
  ): Promise<Uint8Array | undefined> {
    return resetAndSeedFromMarkdownProjection({
      db: deps.db,
      store: deps.store,
      documentId,
      eventSink: deps.eventSink,
    });
  }

  async function writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: UpdateOrigin;
  }): Promise<{ persistedUpdate: PersistedUpdate | null; markdown: string }> {
    const filetype = await filetypeFor(input.documentId);
    // R15 deferred: agent-write token bucket would attach here (openDirectConnection write path).
    const connection = await runtime().openDirectConnection(input.documentId, {
      origin: input.origin,
    });
    try {
      const document = connection.document;
      if (!document) throw new Error("direct connection closed before write");
      const before = Y.encodeStateVector(document);
      await connection.transact((doc) => writeDocFromMarkdown(doc, filetype, input.markdown));
      const update = Y.encodeStateAsUpdate(document, before);
      const persistedUpdate = update.length
        ? await appendUpdateAndAdvanceHead({
            store: deps.store,
            documentId: input.documentId,
            update,
            origin: input.origin,
            document,
            filetype,
            autoCheckpointEvery: deps.autoCheckpointEvery,
          })
        : null;
      return { persistedUpdate, markdown: readDocAsMarkdown(document, filetype) };
    } finally {
      await connection.disconnect({ unloadImmediately: false });
    }
  }

  async function editDocument(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: UpdateOrigin;
  }): Promise<{
    beforeMarkdown: string;
    markdown: string;
    persistedUpdate: PersistedUpdate | null;
  }> {
    const filetype = await filetypeFor(input.documentId);
    const connection = await runtime().openDirectConnection(input.documentId, {
      origin: input.origin,
    });
    try {
      const document = connection.document;
      if (!document) throw new Error("direct connection closed before edit");
      const before = Y.encodeStateVector(document);
      let beforeMarkdown = "";
      await connection.transact((doc) => {
        beforeMarkdown = readDocAsMarkdown(doc, filetype);
        writeDocFromMarkdown(doc, filetype, input.transform(beforeMarkdown));
      });
      const update = Y.encodeStateAsUpdate(document, before);
      const persistedUpdate = update.length
        ? await appendUpdateAndAdvanceHead({
            store: deps.store,
            documentId: input.documentId,
            update,
            origin: input.origin,
            document,
            filetype,
            autoCheckpointEvery: deps.autoCheckpointEvery,
          })
        : null;
      return {
        beforeMarkdown,
        markdown: readDocAsMarkdown(document, filetype),
        persistedUpdate,
      };
    } finally {
      await connection.disconnect({ unloadImmediately: false });
    }
  }

  async function readAsMarkdown(documentId: DocumentId): Promise<string> {
    const live = runtime().documents.get(documentId);
    if (live) return readDocAsMarkdown(live, await filetypeFor(documentId));
    const loaded = await loadDocument(documentId);
    if (!loaded) throw new Error("Document not found");
    const doc = new Y.Doc({ gc: false, gcFilter: () => true });
    Y.applyUpdate(doc, loaded);
    return readDocAsMarkdown(doc, await filetypeFor(documentId));
  }

  function forgetDocument(documentId: DocumentId): void {
    runtime().closeConnections(documentId);
  }

  function collabMetrics(): CollabPersistenceMetrics {
    const runtimeInstance = hocuspocus;
    return {
      queues: queues.metrics(),
      liveDocumentCount:
        runtimeInstance?.getDocumentsCount() ?? runtimeInstance?.documents.size ?? 0,
      openConnectionCount: runtimeInstance?.getConnectionsCount() ?? 0,
    };
  }

  return {
    bind,
    loadDocument,
    persistConnectionUpdate,
    storeDocument,
    drain,
    metrics: collabMetrics,
    writeDocument,
    editDocument,
    readAsMarkdown,
    forgetDocument,
    recoverDocumentFromMarkdownProjection,
  };
}
