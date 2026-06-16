import { loadEnvFile } from "node:process";
import {
  decodeYjsBinaryEnvelope,
  encodeYjsControlFrame,
  parseYjsServerControlFrame,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb, documents, documentYjsUpdates } from "@meridian/database";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import * as Y from "yjs";
import { cookieAuthHeaders, mintWorkOsDevSession } from "./workos-dev-session.js";
import { applyWsSyncPayloadToMarkdown } from "./yjs-smoke-helpers.js";

try {
  loadEnvFile("../../.env");
} catch {}
try {
  loadEnvFile(".env");
} catch {}

const serverUrl = process.env.SMOKE_SERVER_URL;
const databaseUrl = process.env.DATABASE_URL;

if (!serverUrl) throw new Error("SMOKE_SERVER_URL is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

type BootstrapResponse = {
  projectId: string;
  workId: string;
  threadId: string;
  documentId: string;
  uri: string;
};

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

const session = await mintWorkOsDevSession();
const authHeaders = cookieAuthHeaders(session);

const bootstrapResponse = await fetch(new URL("/api/projects/bootstrap-default", serverUrl), {
  method: "POST",
  headers: authHeaders,
});
if (bootstrapResponse.status !== 201) {
  throw new Error(
    `bootstrap failed: ${bootstrapResponse.status} ${await bootstrapResponse.text()}`,
  );
}
const bootstrap = (await bootstrapResponse.json()) as BootstrapResponse;

const messageResponse = await fetch(
  new URL(`/api/threads/${bootstrap.threadId}/messages`, serverUrl),
  {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ text: "prepare a Phase 4 document edit" }),
  },
);
if (messageResponse.status !== 202) {
  throw new Error(`message failed: ${messageResponse.status} ${await messageResponse.text()}`);
}
const messageBody = (await messageResponse.json()) as { assistantTurnId: string };

const markdown = `# Chapter 1\n\nPhase 4 smoke ${Date.now()}\n`;
const expectedMarkdown = markdown.trimEnd();
const writeResponse = await fetch(
  new URL(`/api/threads/${bootstrap.threadId}/context/write`, serverUrl),
  {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      uri: bootstrap.uri,
      markdown,
    }),
  },
);
if (writeResponse.status !== 202) {
  throw new Error(`context write failed: ${writeResponse.status} ${await writeResponse.text()}`);
}
const writeBody = (await writeResponse.json()) as { updateSeq: number };

const readResponse = await fetch(
  new URL(
    `/api/threads/${bootstrap.threadId}/context?uri=${encodeURIComponent(bootstrap.uri)}`,
    serverUrl,
  ),
  { headers: authHeaders },
);
if (readResponse.status !== 200) {
  throw new Error(`context read failed: ${readResponse.status} ${await readResponse.text()}`);
}
const readBody = (await readResponse.json()) as { markdown: string };
if (readBody.markdown !== expectedMarkdown)
  throw new Error("context read did not return written markdown");

const forgetCacheResponse = await fetch(new URL("/api/_smoke/collab/forget-cache", serverUrl), {
  method: "POST",
  headers: { ...authHeaders, "content-type": "application/json" },
  body: JSON.stringify({ documentId: bootstrap.documentId }),
});
if (forgetCacheResponse.status !== 200) {
  throw new Error(
    `forget-cache failed: ${forgetCacheResponse.status} ${await forgetCacheResponse.text()}`,
  );
}

const verifyYjs = new WebSocket(wsUrlFor(serverUrl), {
  headers: authHeaders,
});
await waitForOpen(verifyYjs);
const synced = waitForSyncedMarkdown(verifyYjs, expectedMarkdown);
const subscribed = waitForSubscribed(verifyYjs);
verifyYjs.send(encodeYjsControlFrame({ type: "subscribe", documentId: bootstrap.documentId }));
const { channelIndex } = await subscribed;
const syncedState = await synced;
verifyYjs.close();

const db = createDb(databaseUrl);
const [document] = await db
  .select()
  .from(documents)
  .where(eq(documents.id, bootstrap.documentId as DocumentId));
const [yjsUpdate] = await db
  .select()
  .from(documentYjsUpdates)
  .where(eq(documentYjsUpdates.id, writeBody.updateSeq));
await db.close();

if (document?.markdownProjection !== expectedMarkdown)
  throw new Error("DB markdown projection mismatch");
if (yjsUpdate?.originType !== "user") throw new Error("Yjs update origin_type mismatch");
if (syncedState.channelIndex !== channelIndex) throw new Error("Yjs sync channel mismatch");
if (syncedState.markdown !== expectedMarkdown) throw new Error("Yjs synced markdown mismatch");

console.log(
  JSON.stringify(
    {
      ok: true,
      serverUrl,
      projectId: bootstrap.projectId,
      workId: bootstrap.workId,
      threadId: bootstrap.threadId,
      documentId: bootstrap.documentId,
      assistantTurnId: messageBody.assistantTurnId,
      updateSeq: writeBody.updateSeq,
      yjsChannelIndex: channelIndex,
    },
    null,
    2,
  ),
);
