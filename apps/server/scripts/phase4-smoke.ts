import { loadEnvFile } from "node:process";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb, documents, documentYjsUpdates } from "@meridian/database";
import { eq } from "drizzle-orm";
import { cookieAuthHeaders, mintWorkOsDevSession } from "./workos-dev-session.js";
import { waitForHocuspocusMarkdown } from "./yjs-smoke-helpers.js";

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

const syncedMarkdown = await waitForHocuspocusMarkdown({
  wsUrl: wsUrlFor(serverUrl),
  documentId: bootstrap.documentId,
  authHeaders,
  expectedSubstring: expectedMarkdown,
});

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
if (syncedMarkdown !== expectedMarkdown) throw new Error("Yjs synced markdown mismatch");

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
    },
    null,
    2,
  ),
);
