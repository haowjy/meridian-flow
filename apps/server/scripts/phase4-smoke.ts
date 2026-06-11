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
const supabaseAnonKey = anonKey;

type BootstrapResponse = {
  projectId: string;
  workId: string;
  threadId: string;
  documentId: string;
  uri: string;
};

async function signIn(): Promise<string> {
  const response = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: supabaseAnonKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
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
      const text = raw.toString();
      const frame = parseYjsServerControlFrame(text);
      if (frame?.type === "subscribed") {
        clearTimeout(timeout);
        resolve({ channelIndex: frame.channelIndex });
      }
    });
  });
}

function waitForBinaryUpdate(ws: WebSocket): Promise<{ channelIndex: number; payload: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for yjs update")), 10_000);
    ws.on("message", (raw) => {
      if (typeof raw === "string") return;
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      const envelope = decodeYjsBinaryEnvelope(bytes);
      if (envelope) {
        clearTimeout(timeout);
        resolve({
          channelIndex: envelope.channelIndex,
          payload: Buffer.from(envelope.payload).toString("utf8"),
        });
      }
    });
  });
}

const token = await signIn();

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

const yjs = new WebSocket(wsUrlFor(serverUrl), { headers: { authorization: `Bearer ${token}` } });
await waitForOpen(yjs);
const subscribed = waitForSubscribed(yjs);
yjs.send(encodeYjsControlFrame({ type: "subscribe", documentId: bootstrap.documentId }));
const { channelIndex } = await subscribed;

const messageResponse = await fetch(
  new URL(`/api/threads/${bootstrap.threadId}/messages`, serverUrl),
  {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: "prepare a Phase 4 document edit" }),
  },
);
if (messageResponse.status !== 202) {
  throw new Error(`message failed: ${messageResponse.status} ${await messageResponse.text()}`);
}
const messageBody = (await messageResponse.json()) as { assistantTurnId: string };

const markdown = `# Chapter 1\n\nPhase 4 smoke ${Date.now()}\n`;
const updatePromise = waitForBinaryUpdate(yjs);
const writeResponse = await fetch(
  new URL(`/api/threads/${bootstrap.threadId}/context/write`, serverUrl),
  {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      uri: bootstrap.uri,
      markdown,
      actorTurnId: messageBody.assistantTurnId,
    }),
  },
);
if (writeResponse.status !== 202) {
  throw new Error(`context write failed: ${writeResponse.status} ${await writeResponse.text()}`);
}
const writeBody = (await writeResponse.json()) as { updateSeq: number };
const update = await updatePromise;
yjs.close();

const readResponse = await fetch(
  new URL(
    `/api/threads/${bootstrap.threadId}/context?uri=${encodeURIComponent(bootstrap.uri)}`,
    serverUrl,
  ),
  { headers: { authorization: `Bearer ${token}` } },
);
if (readResponse.status !== 200) {
  throw new Error(`context read failed: ${readResponse.status} ${await readResponse.text()}`);
}
const readBody = (await readResponse.json()) as { markdown: string };
if (readBody.markdown !== markdown) throw new Error("context read did not return written markdown");

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

if (document?.markdownProjection !== markdown) throw new Error("DB markdown projection mismatch");
if (yjsUpdate?.originType !== "agent") throw new Error("Yjs update origin_type mismatch");
if (yjsUpdate?.actorTurnId !== messageBody.assistantTurnId) {
  throw new Error("Yjs update actor_turn_id mismatch");
}
if (update.channelIndex !== channelIndex) throw new Error("Yjs update channel mismatch");
const yjsPayload = JSON.parse(update.payload) as { markdown?: string };
if (yjsPayload.markdown !== markdown) throw new Error("Yjs update payload markdown mismatch");

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
      yjsChannelIndex: update.channelIndex,
    },
    null,
    2,
  ),
);
