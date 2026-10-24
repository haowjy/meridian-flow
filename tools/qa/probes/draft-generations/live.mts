/** Observe a real draft socket through server restart and the HTTP Discard all command. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { COLLAB_SCHEMA_VERSION, formatCollabSchemaSubprotocol } from "@meridian/prosemirror-schema";
import postgres from "postgres";
import WebSocket from "ws";
import * as Y from "yjs";
import { applyDevEnvToProcess } from "../../../dev/lib/dev-env.ts";
import { openSession, unknownJsonResponse } from "../../../mf/src/core/session.ts";

const workId = process.argv[2];
const documentId = process.argv[3];
if (!workId || !documentId)
  throw new Error(
    "Usage: live.mts <workId> <documentId> [--restart] (discards this Work's branch)",
  );
const root = resolve(import.meta.dirname, "../../../..");
applyDevEnvToProcess(root);
const session = await openSession({ repoRoot: root, env: process.env });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("No checkout database");
const db = postgres(databaseUrl, { max: 1 });
const appRequire = createRequire(new URL("../../../../apps/app/package.json", import.meta.url));
const { HocuspocusProvider, HocuspocusProviderWebsocket } = await import(
  appRequire.resolve("@hocuspocus/provider").replace(/\.cjs$/, ".esm.js")
);
const [draft] = await db`select d.id, d.branch_id, b.project_id from document_drafts d
  join branches b on b.id=d.branch_id where b.origin_work_id=${workId}
  and d.document_id=${documentId} and d.status='active' and d.kind='work_draft' order by d.id limit 1`;
await db.end();
assert(draft, "seed one active Work draft first");
const room = `draft:${draft.id}`;
const doc = new Y.Doc({ gc: false });
const closes: { code: number; reason: string }[] = [];
class AuthorizedWebSocket extends WebSocket {
  constructor(url: string) {
    super(url, [formatCollabSchemaSubprotocol(COLLAB_SCHEMA_VERSION)], {
      headers: { Cookie: session.cookie },
      ca: session.ca,
    });
    // ws reports a pre-open close as an error during reconnect cancellation.
    // The bounded sync/close assertions below decide success.
    this.on("error", () => {});
    this.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
  }
}
const socket = new HocuspocusProviderWebsocket({
  url: `${session.serverUrl.replace(/^http/, "ws")}/ws/yjs`,
  WebSocketPolyfill: AuthorizedWebSocket,
  autoConnect: false,
});
let syncs = 0;
const provider = new HocuspocusProvider({
  name: room,
  document: doc,
  websocketProvider: socket,
  onSynced: ({ state }: { state: boolean }) => {
    if (state) syncs++;
  },
});
async function until(check: () => boolean) {
  const deadline = Date.now() + 60000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(closes)}`);
    await new Promise((done) => setTimeout(done, 50));
  }
}
try {
  provider.attach();
  void socket.connect();
  await until(() => syncs > 0);
  const before = doc.getXmlFragment("prosemirror").toString();
  console.log(JSON.stringify({ joined: room, text: before }));
  if (process.argv.includes("--restart")) {
    const previous = syncs;
    execFileSync("pnpm", ["dev:restart"], {
      cwd: root,
      env: { ...process.env, MODEL_PROVIDER: "mock" },
      stdio: "ignore",
      timeout: 90000,
    });
    await until(() => syncs > previous);
    assert.equal(doc.getXmlFragment("prosemirror").toString(), before);
    console.log(JSON.stringify({ restarted: room, syncs, text: before }));
  }
  const answer = await session.request(
    "POST",
    `/api/projects/${draft.project_id}/works/${workId}/branches/discard`,
    { branchId: draft.branch_id, commandId: randomUUID() },
    { decode: unknownJsonResponse },
  );
  await until(() => closes.some((close) => close.code === 4205));
  const terminal = closes.find((close) => close.code === 4205);
  assert.equal(terminal?.reason, "discarded");
  console.log(JSON.stringify({ discard: answer, terminal, room }));
  console.log("PASS G2 live socket restart and HTTP Discard all");
} finally {
  provider.destroy();
  socket.destroy();
  doc.destroy();
}
