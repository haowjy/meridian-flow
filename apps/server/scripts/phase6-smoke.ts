import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";
import {
  decodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsServerControlFrame,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId } from "@meridian/contracts/runtime";
import { checkpointIdForBlock } from "@meridian/contracts/threads";
import {
  createDb,
  documentYjsUpdates,
  threadDocuments,
  threads,
  turnBlocks,
  turns,
} from "@meridian/database";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import * as Y from "yjs";
import { createDocumentSyncService } from "../server/domains/collab/index.js";
import { createProductionUnifiedContextPortFactory } from "../server/domains/context/index.js";
import { createRuntimeToolRegistry } from "../server/domains/runtime/tool-registry.js";
import { applyWsSyncPayloadToMarkdown } from "./yjs-smoke-helpers.js";

try {
  loadEnvFile("../../.env");
} catch {}
try {
  loadEnvFile(".env");
} catch {}

const serverUrl = process.env.SMOKE_SERVER_URL;
const databaseUrl = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.TEST_USER_EMAIL ?? "test@meridian.dev";
const password = process.env.TEST_USER_PASSWORD ?? "meridian-dev";

if (!serverUrl) throw new Error("SMOKE_SERVER_URL is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!supabaseUrl || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY are required");

type BootstrapResponse = {
  threadId: ThreadId;
  documentId: DocumentId;
  uri: string;
};

async function signIn(): Promise<{ token: string; userId: UserId }> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string; user: { id: UserId } };
  return { token: body.access_token, userId: body.user.id };
}

function wsUrlFor(url: string): string {
  const parsed = new URL("/ws/yjs", url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(error));
  });
}

function waitForSubscribed(ws: WebSocket): Promise<{ channelIndex: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for yjs subscribed")),
      10_000,
    );
    ws.on("message", (raw) => {
      if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return;
      const frame = parseYjsServerControlFrame(raw.toString());
      if (frame?.type === "subscribed") {
        clearTimeout(timeout);
        resolve({ channelIndex: frame.channelIndex });
      }
    });
  });
}

function waitForSyncedMarkdown(
  ws: WebSocket,
  expected: string,
): Promise<{ channelIndex: number; markdown: string }> {
  const doc = new Y.Doc();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      doc.destroy();
      reject(new Error("timed out waiting for yjs markdown sync"));
    }, 10_000);
    ws.on("message", (raw) => {
      if (typeof raw === "string") return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      if (bytes[0] === 0x7b) return;
      const envelope = decodeYjsBinaryEnvelope(bytes);
      if (envelope?.payload[0] !== 0) return;
      const markdown = applyWsSyncPayloadToMarkdown(doc, envelope.payload);
      if (markdown.includes(expected)) {
        clearTimeout(timeout);
        doc.destroy();
        resolve({ channelIndex: envelope.channelIndex, markdown });
      }
    });
  });
}

const { token, userId } = await signIn();

const bootstrapResponse = await fetch(new URL("/api/projects/bootstrap-default", serverUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});
if (bootstrapResponse.status !== 201) {
  throw new Error(
    `bootstrap failed: ${bootstrapResponse.status} ${await bootstrapResponse.text()}`,
  );
}
const bootstrap = (await bootstrapResponse.json()) as BootstrapResponse;

const messageText = `phase six edit ${Date.now()}`;
const expectedSnippet = `Acknowledged: ${messageText}`;
const messageResponse = await fetch(
  new URL(`/api/threads/${bootstrap.threadId}/messages`, serverUrl),
  {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: messageText }),
  },
);
if (messageResponse.status !== 202) {
  throw new Error(`message failed: ${messageResponse.status} ${await messageResponse.text()}`);
}
const messageBody = (await messageResponse.json()) as { assistantTurnId: TurnId };

const db = createDb(databaseUrl);
let agentUpdate: typeof documentYjsUpdates.$inferSelect | undefined;
for (let attempt = 0; attempt < 60; attempt++) {
  const [update] = await db
    .select()
    .from(documentYjsUpdates)
    .where(eq(documentYjsUpdates.actorTurnId, messageBody.assistantTurnId))
    .limit(1);
  if (update) {
    agentUpdate = update;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!agentUpdate) throw new Error("timed out waiting for agent-attributed Yjs update");

const forgetCacheResponse = await fetch(new URL("/api/_smoke/collab/forget-cache", serverUrl), {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ documentId: bootstrap.documentId }),
});
if (forgetCacheResponse.status !== 200) {
  throw new Error(
    `forget-cache failed: ${forgetCacheResponse.status} ${await forgetCacheResponse.text()}`,
  );
}

const verifyYjs = new WebSocket(wsUrlFor(serverUrl), {
  headers: { authorization: `Bearer ${token}` },
});
await waitForOpen(verifyYjs);
const synced = waitForSyncedMarkdown(verifyYjs, expectedSnippet);
const subscribed = waitForSubscribed(verifyYjs);
verifyYjs.send(encodeYjsControlFrame({ type: "subscribe", documentId: bootstrap.documentId }));
const { channelIndex } = await subscribed;
const syncedState = await synced;
verifyYjs.close();
if (syncedState.channelIndex !== channelIndex) throw new Error("Yjs sync channel mismatch");
if (!syncedState.markdown.includes(expectedSnippet)) {
  throw new Error("Yjs synced markdown missing agent edit");
}

if (agentUpdate.originType !== "agent") throw new Error("Yjs update origin_type mismatch");

const documentSync = createDocumentSyncService({ db });
const contextPorts = createProductionUnifiedContextPortFactory({ db, documentSync });
const registry = createRuntimeToolRegistry({ db, contextPorts });
const spawnToolContext = {
  threadId: bootstrap.threadId,
  userId,
  assistantTurnId: messageBody.assistantTurnId,
};

const checkpointTurnId = randomUUID() as TurnId;
await db.transaction(async (tx) => {
  await tx
    .update(threads)
    .set({ activeLeafTurnId: null })
    .where(eq(threads.id, bootstrap.threadId));
  await tx.insert(turns).values({
    id: checkpointTurnId,
    threadId: bootstrap.threadId,
    parentTurnId: messageBody.assistantTurnId,
    role: "assistant",
    status: "streaming",
  });
  await tx
    .update(threads)
    .set({ activeLeafTurnId: checkpointTurnId })
    .where(eq(threads.id, bootstrap.threadId));
});
const checkpointToolContext = {
  threadId: bootstrap.threadId,
  userId,
  assistantTurnId: checkpointTurnId,
};
const checkpoint = await registry.askUser(checkpointToolContext, "Choose the next scene goal.");
const [waitingTurn] = await db.select().from(turns).where(eq(turns.id, checkpointTurnId)).limit(1);
if (waitingTurn?.status !== "waiting_checkpoint") throw new Error("ask_user did not checkpoint");
if (waitingTurn.completedAt !== null) throw new Error("ask_user set a terminal completed_at");
const [checkpointBlock] = await db
  .select()
  .from(turnBlocks)
  .where(eq(turnBlocks.id, checkpoint.result.blockId))
  .limit(1);
if (checkpointBlock?.blockType !== "custom") throw new Error("ask_user block missing");
const extractedCheckpointId = checkpointIdForBlock({
  id: checkpointBlock.id,
  turnId: checkpointBlock.turnId,
  responseId: checkpointBlock.responseId,
  blockType: checkpointBlock.blockType,
  status: checkpointBlock.status,
  sequence: checkpointBlock.sequence,
  textContent: checkpointBlock.textContent,
  content: checkpointBlock.content,
  modelText: checkpointBlock.modelText ?? undefined,
  compact: checkpointBlock.compact ?? undefined,
  pruned: checkpointBlock.pruned,
  provider: checkpointBlock.provider,
  providerData: checkpointBlock.providerData,
  executionSide: checkpointBlock.executionSide,
  collapsedContent: checkpointBlock.collapsedContent,
  createdAt: checkpointBlock.createdAt.toISOString(),
});
if (!extractedCheckpointId) throw new Error("ask_user checkpoint id missing from block content");
if (extractedCheckpointId !== checkpoint.result.checkpointId) {
  throw new Error("ask_user checkpoint id mismatch");
}

const spawned = await registry.spawn(spawnToolContext, "Check continuity for chapter one.");
const childThreadId = spawned.result.childThreadId as ThreadId;
const [runningChild] = await db
  .select()
  .from(threads)
  .where(eq(threads.id, childThreadId))
  .limit(1);
if (runningChild?.kind !== "subagent") throw new Error("spawn did not create subagent thread");
if (runningChild.originType !== "spawn") throw new Error("spawn origin_type mismatch");
if (runningChild.parentThreadId !== bootstrap.threadId) throw new Error("spawn parent mismatch");
if (runningChild.originTurnId !== messageBody.assistantTurnId)
  throw new Error("spawn turn mismatch");
if (runningChild.spawnStatus !== "running") throw new Error("spawn did not start running");
if (!runningChild.activeLeafTurnId) throw new Error("spawn child missing active leaf");
if (runningChild.turnCount !== 1)
  throw new Error(`spawn child turn_count=${runningChild.turnCount}`);
const [childRootTurn] = await db
  .select()
  .from(turns)
  .where(eq(turns.id, runningChild.activeLeafTurnId))
  .limit(1);
if (childRootTurn?.threadId !== childThreadId) throw new Error("spawn active leaf turn missing");
const childDocuments = await db
  .select()
  .from(threadDocuments)
  .where(eq(threadDocuments.threadId, childThreadId));
if (childDocuments.length === 0) throw new Error("spawn did not copy thread_documents");

await registry.markSpawnSucceeded(childThreadId);
const [succeededChild] = await db
  .select()
  .from(threads)
  .where(eq(threads.id, childThreadId))
  .limit(1);
await db.close();
if (succeededChild?.spawnStatus !== "succeeded") throw new Error("spawn did not succeed");
if (!succeededChild.updatedAt || succeededChild.updatedAt < runningChild.updatedAt) {
  throw new Error("spawn success did not touch child activity");
}

console.log(
  JSON.stringify(
    {
      ok: true,
      serverUrl,
      threadId: bootstrap.threadId,
      documentId: bootstrap.documentId,
      assistantTurnId: messageBody.assistantTurnId,
      updateSeq: agentUpdate.id,
      checkpointBlockId: checkpoint.result.blockId,
      childThreadId,
    },
    null,
    2,
  ),
);
