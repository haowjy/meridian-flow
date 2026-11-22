/**
 * History compaction of a Live room and its fork, on a scratch database (recipe:
 * `history-compaction.md` beside this file). Bounds are lowered so a small room compacts and a
 * mark ripens in under a second.
 */
import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import {
  encodeEnvelope,
  freshPeerId,
  HistoryCutoffError,
  readDocument,
  writeDocument,
} from "@meridian/document-model";
import { blocksOf, nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  packCollabSchemaVersion,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import { LoroDoc } from "loro-crdt";
import postgres from "postgres";
import { createScratchDatabase } from "../../../../../../../../tools/qa/probes/model-edit-harness/scratch.mts";
import { treeSeeder } from "../../../../../test-support/tree-seed.js";
import type { EventRecord } from "../../../../observability/index.js";
import {
  liveMarkdown,
  writeLiveMarkdown,
  writerEdit,
} from "../../../test-support/live-room-text.js";
import { createPostgresDocumentRooms } from "../../postgres-document-rooms.js";

const HISTORY_MS = 600;
const schema = buildDocumentSchema();
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const scratch = await createScratchDatabase();
const db = createDb(scratch.url, { max: 4 });
const raw = postgres(scratch.url, { max: 1 });
const events: EventRecord[] = [];
const rooms = createPostgresDocumentRooms({
  db,
  shape: shapeSchemaOf(schema),
  eventSink: {
    emit: (event) => events.push(event),
    emitBatch: (batch) => events.push(...batch),
    flush: async () => {},
  },
  schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
  bounds: { compactBytes: 1, historyMs: HISTORY_MS },
});
try {
  const user = randomUUID();
  const project = randomUUID();
  const source = randomUUID();
  const documentId = randomUUID() as DocumentId;
  const draftId = "probe0000001";
  await raw`insert into users(id,external_id,email) values (${user},${`probe-${user}`},${`probe-${user}@example.invalid`})`;
  await raw`insert into projects(id,user_id,name,slug) values (${project},${user},'probe','probe')`;
  await raw`insert into context_sources(id,project_id,slug,scope) values (${source},${project},'manuscript','project')`;
  await treeSeeder(db).document(source, "chapter.md", { id: documentId });
  await raw`insert into drafts(id,project_id,created_by) values (${draftId},${project},${user})`;
  await raw`insert into document_forks(draft_id,document_id) values (${draftId},${documentId})`;
  const live = { kind: "live", documentId } as const;
  const fork = { kind: "fork", draftId, documentId } as const;
  /** The writer retypes the last paragraph `rounds` times: one block, a long history. */
  const type = async (rounds: number, label: string) => {
    for (let i = 0; i < rounds; i++)
      await writerEdit(rooms, documentId, (current) => [
        ...current.slice(0, -1),
        schema.nodes.paragraph.create(
          current.at(-1)?.attrs,
          schema.text(`${label} draft ${i}, retyped.`),
        ),
      ]);
    await rooms.flush(live);
  };
  const rows = (roomKey: string) =>
    raw<{ doc_key: string; bytes: number; snapshot: Uint8Array }[]>`
      select doc_key, octet_length(snapshot) as bytes, snapshot from document_snapshots
      where room_key = ${roomKey} order by doc_key`;
  const seq = async () =>
    (await raw<{ n: string }[]>`select content_seq::text as n from documents where id = ${documentId}`)[0]?.n;

  await writeLiveMarkdown(rooms, documentId, "Opening.\n\nFirst.");
  await rooms.flush(live);
  // A tab that joins now and goes offline: its base will fall below the second cut.
  const staleTab = await rooms.read(live, { peer: freshPeerId() });
  // The fork's own paragraph, written into the fork room as a Draft-mode tab would.
  const forkTab = await rooms.read(fork, { peer: freshPeerId() });
  const before = forkTab.shownVersion();
  writeDocument(
    forkTab,
    blocksOf(
      withBlockIds(
        schema.topNodeType.create(null, [
          ...readDocument(forkTab).map((block) => nodeOf(schema, block)),
          schema.nodes.paragraph.create(null, schema.text("Only in the fork.")),
        ]),
      ),
    ),
  );
  await rooms.write(fork, encodeEnvelope(forkTab.exportSince(before)), "probe:fork-tab");
  forkTab.free();
  await rooms.flush(fork);

  // Cut 1: the marks set when the rows were made ripen; history before them goes.
  await type(150, "second");
  await sleep(HISTORY_MS + 200);
  await rooms.unload(live);
  check(
    events.some((event) => event.name === "history.compacted"),
    "an unload past the bounds compacts",
  );
  // Cut 2: the marks cut 1 left are where the second typing ended.
  await type(150, "third");
  const text = await liveMarkdown(rooms, documentId);
  const seqBefore = await seq();
  const sizeBefore = (await rows(`live:${documentId}`)).reduce((sum, row) => sum + row.bytes, 0);
  await sleep(HISTORY_MS + 200);
  events.length = 0;
  await rooms.unload(live);
  const compacted = events.find((event) => event.name === "history.compacted");
  const sizeAfter = (await rows(`live:${documentId}`)).reduce((sum, row) => sum + row.bytes, 0);
  console.log(`     live rows ${sizeBefore} -> ${sizeAfter} bytes; event ${JSON.stringify(compacted?.payload)}`);
  check(sizeAfter < sizeBefore, "the second cut shrinks the Live rows");
  check((await liveMarkdown(rooms, documentId)) === text, "the text is the same after the cut");
  check((await seq()) === seqBefore, "a cut does not move content_seq");
  // A row the cut would not shrink keeps its history; the retyped paragraph's is the big one.
  const [largest] = (await rows(`live:${documentId}`)).sort((a, b) => b.bytes - a.bytes);
  const doc = LoroDoc.fromSnapshot(largest?.snapshot ?? new Uint8Array());
  check(doc.isShallow(), "the retyped paragraph's row is a shallow snapshot");
  doc.free();
  await rooms.unload(live);

  // The fork was cut at Live's marks: it keeps its paragraph and still imports Live.
  await writeLiveMarkdown(rooms, documentId, "Opening.\n\nAfter the cut.");
  await rooms.flush(live);
  const forkCopy = await rooms.read(fork);
  const forkText = readDocument(forkCopy)
    .map((block) => nodeOf(schema, block).textContent)
    .join(" | ");
  forkCopy.free();
  console.log(`     fork reads: ${forkText}`);
  check(forkText.includes("Only in the fork."), "the fork keeps its own paragraph");
  check(forkText.includes("After the cut."), "the fork imports Live's typing after the cut");

  // The tab offline since before the cuts types, and is refused; a fresh tab is not.
  const staleBefore = staleTab.version();
  const staleBlock = readDocument(staleTab).at(-1);
  if (staleBlock?.kind === "text")
    staleTab.textOf(staleBlock.id)?.getText("t").insert(0, "Offline ");
  staleTab.textOf(staleBlock?.id ?? "")?.commit();
  const staleBatch = encodeEnvelope(staleTab.exportSince(staleBefore));
  staleTab.free();
  let refused: unknown = null;
  try {
    await rooms.write(live, staleBatch, "probe:stale-tab");
  } catch (error) {
    refused = error;
  }
  check(refused instanceof HistoryCutoffError, "a tab whose base is below the cut is refused");
  await writeLiveMarkdown(rooms, documentId, "Opening.\n\nA fresh tab types.");
  await rooms.flush(live);
  check(
    (await liveMarkdown(rooms, documentId)).includes("A fresh tab types."),
    "a tab joined after the cut writes",
  );
} finally {
  await rooms.close();
  await db.close();
  await raw.end();
  await scratch.drop();
}
if (failures.length > 0) {
  console.error(`${failures.length} failed`);
  process.exit(1);
}
console.log("all passed");
