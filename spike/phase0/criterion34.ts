/** Phase 0 criteria 3-4 inversion/durability probe using Hocuspocus v4 + real Drizzle DocumentStore. */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { Hocuspocus, isTransactionOrigin, type TransactionOrigin } from "@hocuspocus/server";
import {
  contextSources,
  createDb,
  documents,
  documentYjsUpdates,
  projects,
  threads,
  turns,
  users,
} from "@meridian/database";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import WebSocket, { WebSocketServer } from "ws";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import * as Y from "yjs";
import { createDrizzleDocumentStore } from "../../apps/server/server/domains/collab/adapters/drizzle/document-store.js";
import { createDocumentSyncService as createInnerDocumentSyncService } from "../../apps/server/server/domains/collab/domain/document-sync-service.js";
import {
  getSchema,
  markdownToNode,
  nodeToMarkdown,
} from "../../apps/server/server/domains/collab/domain/schemas.js";
import { originColumns } from "../../apps/server/server/domains/collab/domain/yjs-mirror.js";
import type { UpdateOrigin } from "../../apps/server/server/domains/collab/ports/document-sync.js";
import { KeyedMutex } from "../../apps/server/server/shared/keyed-mutex.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL required (throwaway DB)");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function markdownOf(doc: Y.Doc): string {
  const root = yXmlFragmentToProseMirrorRootNode(
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    getSchema("document"),
  );
  return nodeToMarkdown("document", root);
}

function writeMarkdown(doc: Y.Doc, markdown: string): void {
  updateYFragment(
    doc,
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
    markdownToNode("document", markdown),
    {
      mapping: new Map(),
      isOMark: new Map(),
    },
  );
}

function mergeParts(parts: Uint8Array[]): Uint8Array | undefined {
  return parts.length === 0 ? undefined : Y.mergeUpdates(parts);
}

class Fifo {
  private tails = new Map<string, Promise<void>>();
  depths = new Map<string, number>();
  maxDepths = new Map<string, number>();
  enqueue(documentId: string, fn: () => Promise<void>) {
    const depth = (this.depths.get(documentId) ?? 0) + 1;
    this.depths.set(documentId, depth);
    this.maxDepths.set(documentId, Math.max(this.maxDepths.get(documentId) ?? 0, depth));
    const next = (this.tails.get(documentId) ?? Promise.resolve())
      .then(fn)
      .finally(() => this.depths.set(documentId, (this.depths.get(documentId) ?? 1) - 1));
    this.tails.set(
      documentId,
      next.catch(() => {}),
    );
    return next;
  }
  async drain(documentId: string) {
    await (this.tails.get(documentId) ?? Promise.resolve());
  }
}

function deriveOrigin(origin: unknown): UpdateOrigin | null {
  if (!isTransactionOrigin(origin)) return null;
  if (origin.source === "connection")
    return { type: "user", userId: origin.connection.context.userId };
  if (origin.source === "local") return origin.context?.origin ?? null;
  return null;
}

async function rows(db: ReturnType<typeof createDb>, documentId: string) {
  return db
    .select({
      id: documentYjsUpdates.id,
      originType: documentYjsUpdates.originType,
      actorUserId: documentYjsUpdates.actorUserId,
      actorTurnId: documentYjsUpdates.actorTurnId,
    })
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.documentId, documentId))
    .orderBy(documentYjsUpdates.id);
}

async function main() {
  const db = createDb(DATABASE_URL, { max: 4 });
  const store = createDrizzleDocumentStore(db);
  const seedSync = createInnerDocumentSyncService(store, {
    compaction: false,
    autoCheckpointEvery: 1000,
  });
  const userId = randomUUID();
  const projectId = randomUUID();
  const docId = randomUUID();
  const threadId = randomUUID();
  const agentTurnId = randomUUID();
  await db.insert(users).values({
    id: userId,
    externalId: `phase0-${userId}`,
    email: `phase0-${userId}@example.invalid`,
    name: "Phase 0 Spike",
  });
  await db
    .insert(projects)
    .values({ id: projectId, userId, name: "Phase0", slug: `phase0-${projectId}` });
  await db.insert(contextSources).values({
    id: projectId,
    projectId,
    name: "Phase0",
    slug: `phase0-src-${projectId}`,
    scope: "project",
  });
  await db.insert(threads).values({
    id: threadId,
    projectId,
    createdByUserId: userId,
    title: "Phase0 Thread",
    kind: "primary",
    status: "active",
  });
  await db
    .insert(turns)
    .values({ id: agentTurnId, threadId, role: "assistant", status: "complete" });
  await db.insert(documents).values({
    id: docId,
    contextSourceId: projectId,
    name: "phase0",
    extension: "md",
    fileType: "markdown",
    markdownProjection: "Block A\n\nBlock B",
  });
  const seeded = await seedSync.getOrCreateMirror(docId, "Block A\n\nBlock B", "markdown");
  if (!seeded.ok) throw new Error(`seed failed ${JSON.stringify(seeded.error)}`);

  const fifo = new Fifo();
  const mutex = new KeyedMutex();
  const artificialDelayMs = Number(process.env.SPIKE_SLOW_STORE_MS ?? 0);

  async function appendAndHead(
    documentId: string,
    update: Uint8Array,
    origin: UpdateOrigin,
    doc: Y.Doc,
  ) {
    if (artificialDelayMs) await sleep(artificialDelayMs);
    let seq = 0;
    await store.transaction(async (tx) => {
      seq = await tx.appendUpdate({ documentId, updateData: update, ...originColumns(origin) });
      const head = await tx.getHead(documentId);
      await tx.upsertHead({
        documentId,
        fragmentName: PROSEMIRROR_FRAGMENT_NAME,
        filetype: "markdown",
        latestUpdateSeq: seq,
        latestStateVector: Y.encodeStateVector(doc),
        latestCheckpointId: head?.latestCheckpointId ?? null,
      });
    });
    return seq;
  }

  const hocuspocus = new Hocuspocus({
    name: "phase0-inversion",
    debounce: 100,
    maxDebounce: 200,
    async onLoadDocument({ documentName }) {
      const head = await store.getHead(documentName);
      if (!head) return undefined;
      const ckpt = await store.getLatestCheckpoint(documentName);
      const updates = await store.listUpdatesAfter(documentName, ckpt?.upToSeq ?? 0);
      return mergeParts([
        ...(ckpt ? [ckpt.state] : []),
        ...updates.filter((u) => u.seq <= head.latestUpdateSeq).map((u) => u.updateData),
      ]);
    },
    async onConnect({ context }) {
      context.userId ??= userId;
    },
    async onChange({ documentName, update, transactionOrigin, document }) {
      const origin = deriveOrigin(transactionOrigin as TransactionOrigin);
      const source = isTransactionOrigin(transactionOrigin) ? transactionOrigin.source : "unknown";
      if (!origin || source !== "connection") return;
      fifo.enqueue(documentName, () => appendAndHead(documentName, update, origin, document));
    },
  });

  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, request) => {
    const conn = hocuspocus.handleConnection(
      ws as never,
      new Request(`http://localhost${request.url ?? "/"}`),
      { userId },
    );
    ws.on("message", (data) =>
      conn.handleMessage(
        data instanceof Buffer ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer),
      ),
    );
    ws.on("close", (code, reason) => conn.handleClose({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const url = `ws://127.0.0.1:${address.port}`;

  const editorDoc = new Y.Doc();
  const observerDoc = new Y.Doc();
  const editor = new HocuspocusProvider({
    url,
    name: docId,
    document: editorDoc,
    WebSocketPolyfill: WebSocket,
    token: null,
    delay: 50,
    minDelay: 50,
    maxAttempts: 2,
  });
  const observer = new HocuspocusProvider({
    url,
    name: docId,
    document: observerDoc,
    WebSocketPolyfill: WebSocket,
    token: null,
    delay: 50,
    minDelay: 50,
    maxAttempts: 2,
  });
  await waitFor(() => editor.isSynced && observer.isSynced, "editor/observer synced");

  async function agentWrite(markdown: string) {
    return mutex.run(docId, async () => {
      const conn = await hocuspocus.openDirectConnection(docId, {
        origin: { type: "agent", actorTurnId: agentTurnId } satisfies UpdateOrigin,
      });
      const document = conn.document;
      if (!document) throw new Error("direct connection closed before transaction");
      const before = Y.encodeStateVector(document);
      await conn.transact((doc) => writeMarkdown(doc, markdown));
      const delta = Y.encodeStateAsUpdate(document, before);
      const seq = delta.length
        ? await appendAndHead(docId, delta, conn.context.origin, document)
        : 0;
      await conn.disconnect({ unloadImmediately: false });
      return { seq, deltaLength: delta.length };
    });
  }

  const beforeAgent = await rows(db, docId);
  const agentResult = await agentWrite("Block A\n\nAgent B");
  const rowsAfterAgent = await rows(db, docId);
  await waitFor(() => markdownOf(editorDoc).includes("Agent B"), "agent write visible to editor");
  await sleep(200);
  await fifo.drain(docId);
  const rowsAfterDrain = await rows(db, docId);
  console.log(
    "CRITERION3_AGENT",
    JSON.stringify({
      beforeRows: beforeAgent.length,
      agentResult,
      rowsAfterAgent,
      rowsAfterDrain,
      editorMarkdown: markdownOf(editorDoc),
    }),
  );

  writeMarkdown(editorDoc, "Human A\n\nAgent B");
  await waitFor(
    () => markdownOf(observerDoc).includes("Human A"),
    "human edit visible to observer",
  );
  const immediateDepth = fifo.depths.get(docId) ?? 0;
  await fifo.drain(docId);
  const rowsAfterHuman = await rows(db, docId);
  console.log(
    "CRITERION3_HUMAN",
    JSON.stringify({
      immediateDepth,
      maxDepth: fifo.maxDepths.get(docId) ?? 0,
      rowsAfterHuman,
      observerMarkdown: markdownOf(observerDoc),
    }),
  );

  const floodStart = Date.now();
  for (let i = 0; i < 25; i++) writeMarkdown(editorDoc, `Flood ${i}\n\nAgent B`);
  await sleep(50);
  const floodQueuedImmediately = fifo.depths.get(docId) ?? 0;
  await fifo.drain(docId);
  console.log(
    "CRITERION3_QUEUE",
    JSON.stringify({
      artificialDelayMs,
      floodQueuedImmediately,
      maxDepth: fifo.maxDepths.get(docId) ?? 0,
      drainMs: Date.now() - floodStart,
    }),
  );

  writeMarkdown(editorDoc, "Human A2\n\nAgent B");
  const agentConcurrent = agentWrite("Human A2\n\nAgent B2");
  await agentConcurrent;
  await waitFor(
    () =>
      markdownOf(observerDoc).includes("Human A2") && markdownOf(observerDoc).includes("Agent B2"),
    "different-block convergence",
  );
  console.log(
    "CRITERION4_DIFFERENT_BLOCKS",
    JSON.stringify({
      editorMarkdown: markdownOf(editorDoc),
      observerMarkdown: markdownOf(observerDoc),
    }),
  );

  writeMarkdown(editorDoc, "Same human\n\nAgent B2");
  const stale = markdownOf(editorDoc);
  await agentWrite(stale.replace("Same human", "Same agent"));
  await waitFor(() => markdownOf(observerDoc).includes("Same agent"), "same-block convergence");
  console.log(
    "CRITERION4_SAME_BLOCK",
    JSON.stringify({
      editorMarkdown: markdownOf(editorDoc),
      observerMarkdown: markdownOf(observerDoc),
    }),
  );

  editor.destroy();
  observer.destroy();
  wss.close();
  server.close();
  await db.close();
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
