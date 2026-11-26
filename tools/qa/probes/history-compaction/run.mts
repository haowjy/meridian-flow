import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts/runtime";
import { createDb } from "@meridian/database";
import {
  applyBlocks,
  applyOps,
  discardBlocks,
  encodeEnvelope,
  freshPeerId,
  freshServerPeerId,
  HistoryCutoffError,
  readDocument,
  writeDocument,
} from "@meridian/document-model";
import { blocksOf, nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  newBlockId,
  packCollabSchemaVersion,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import { LoroDoc } from "loro-crdt";
import postgres from "postgres";
import { createPostgresDocumentRooms } from "../../../../apps/server/server/domains/collab/rooms/postgres-document-rooms.ts";
import {
  liveMarkdown,
  writeLiveMarkdown,
  writerEdit,
} from "../../../../apps/server/server/domains/collab/test-support/live-room-text.ts";
import type { EventRecord } from "../../../../apps/server/server/domains/observability/index.ts";
import { treeSeeder } from "../../../../apps/server/server/test-support/tree-seed.ts";
import { createScratchDatabase } from "../model-edit-harness/scratch.mts";

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
  const live = { kind: "live", documentId } as const;
  const fork = { kind: "fork", draftId, documentId } as const;
  const type = async (rounds: number, label: string) => {
    for (let i = 0; i < rounds; i++)
      await writerEdit(rooms, documentId, (current) => [
        schema.nodes.paragraph.create(current[0]?.attrs, schema.text(`Opening ${label} ${i}.`)),
        ...current.slice(1, -1),
        schema.nodes.paragraph.create(
          current.at(-1)?.attrs,
          schema.text(`${label} draft ${i}, retyped.`),
        ),
      ]);
    await rooms.flush(live);
  };
  const forkRow = async (draft: string) =>
    (
      await raw<{ pending: boolean }[]>`
        select pending from document_forks where draft_id = ${draft} and document_id = ${documentId}`
    )[0];
  const rows = (roomKey: string) =>
    raw<{ doc_key: string; bytes: number; snapshot: Uint8Array }[]>`
      select doc_key, octet_length(snapshot) as bytes, snapshot from document_snapshots
      where room_key = ${roomKey} order by doc_key`;
  const seq = async () =>
    (
      await raw<
        { n: string }[]
      >`select content_seq::text as n from documents where id = ${documentId}`
    )[0]?.n;

  await writeLiveMarkdown(rooms, documentId, "Opening.\n\nFirst.");
  await rooms.flush(live);
  const staleTab = await rooms.read(live, { peer: freshPeerId() });
  const forkTab = await rooms.read(fork, { peer: freshPeerId() });
  const before = forkTab.shownVersion();
  const [opening, ...rest] = readDocument(forkTab).map((block) => nodeOf(schema, block));
  const openingId = String(opening?.attrs.id);
  writeDocument(
    forkTab,
    blocksOf(
      withBlockIds(
        schema.topNodeType.create(null, [
          schema.nodes.paragraph.create(opening?.attrs, schema.text("Opening, drafted.")),
          ...rest,
          schema.nodes.paragraph.create(null, schema.text("Only in the fork.")),
        ]),
      ),
    ),
  );
  await rooms.write(fork, encodeEnvelope(forkTab.exportSince(before)), "probe:fork-tab");
  forkTab.free();
  await rooms.flush(fork);
  check(
    (await forkRow(draftId))?.pending === true,
    "the fork's first save writes its row, pending",
  );

  await type(150, "second");
  await sleep(HISTORY_MS + 200);
  await rooms.unload(live);
  check(
    events.some((event) => event.name === "history.compacted"),
    "an unload past the bounds compacts",
  );
  await type(150, "third");
  const text = await liveMarkdown(rooms, documentId);
  const seqBefore = await seq();
  const sizeBefore = (await rows(`live:${documentId}`)).reduce((sum, row) => sum + row.bytes, 0);
  await sleep(HISTORY_MS + 200);
  events.length = 0;
  await rooms.unload(live);
  const compacted = events.find((event) => event.name === "history.compacted");
  const sizeAfter = (await rows(`live:${documentId}`)).reduce((sum, row) => sum + row.bytes, 0);
  console.log(
    `     live rows ${sizeBefore} -> ${sizeAfter} bytes; event ${JSON.stringify(compacted?.payload)}`,
  );
  check(sizeAfter < sizeBefore, "the second cut shrinks the Live rows");
  check((await liveMarkdown(rooms, documentId)) === text, "the text is the same after the cut");
  check((await seq()) === seqBefore, "a cut does not move content_seq");
  const liveRows = await rows(`live:${documentId}`);
  const shallow = (key: string) => {
    const doc = LoroDoc.fromSnapshot(
      liveRows.find((row) => row.doc_key === key)?.snapshot ?? new Uint8Array(),
    );
    const out = doc.isShallow();
    doc.free();
    return out;
  };
  const reader = await rooms.read(live);
  const lastId = readDocument(reader).at(-1)?.id ?? "";
  reader.free();
  check(shallow(lastId), "the retyped paragraph's row is a shallow snapshot");
  check(!shallow(openingId), "a paragraph a fork wrote ahead of Live keeps Live's history");
  await rooms.unload(live);

  const press = await rooms.read(fork);
  try {
    const pressLive = press.live;
    if (!pressLive) throw new Error("a fork copy has a Live copy");
    const liveBase = pressLive.version();
    const forkBase = press.version();
    const result = applyBlocks(press, [openingId], {
      liveVersion: new Map(),
      by: { press: "probe" },
    });
    await rooms.commit(db, live, encodeEnvelope(pressLive.exportSince(liveBase)), "press:probe");
    await rooms.commit(db, fork, encodeEnvelope(press.exportSince(forkBase)), "press:probe");
    const drafted = readDocument(press).find((block) => block.id === openingId);
    const landed = (await liveMarkdown(rooms, documentId)).split("\n\n")[0];
    console.log(`     applied after the cut: ${JSON.stringify(landed)}`);
    check(
      result.chosen.length === 1 &&
        drafted !== undefined &&
        landed === nodeOf(schema, drafted).textContent,
      "an old draft change applies after its Live room compacted",
    );
  } finally {
    press.free();
  }
  await rooms.flush(fork);
  await rooms.unload(live);

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

  const origins: string[] = [];
  const stop = rooms.subscribe(live, (batch) => origins.push(batch.origin));
  const tab = await rooms.read(live, { peer: freshPeerId() });
  const tabBase = tab.version();
  const agent = await rooms.read(live, { peer: freshServerPeerId() });
  const agentBase = agent.version();
  const target = readDocument(agent).at(-1);
  const content = [{ kind: "text" as const, text: "The AI adds this. ", marks: {} }];
  const ai = applyOps(
    agent,
    [
      {
        kind: "text",
        block: target?.id ?? "",
        splices: [{ from: 0, to: 0, content }],
        formats: [],
      },
    ],
    { by: { turn: "probe" }, newBlockId },
  );
  await rooms.commit(db, live, encodeEnvelope(agent.exportSince(agentBase)), "turn:probe");
  agent.free();
  writeDocument(tab, readDocument(tab).slice(0, -1));
  await rooms.write(live, encodeEnvelope(tab.exportSince(tabBase)), "probe:tab");
  tab.free();
  const raced = await liveMarkdown(rooms, documentId);
  console.log(`     after the race: ${JSON.stringify(raced)}`);
  check(
    ai.ok && raced.includes("The AI adds this. A fresh tab types."),
    "a tab's removal that did not read the AI's text: the room brings the paragraph back",
  );
  check(origins.includes("server:restore"), "the room sends its restore to every socket");
  stop();
  await rooms.flush(live);
  await rooms.unload(live);
  check(
    (await liveMarkdown(rooms, documentId)).includes("The AI adds this."),
    "the restore is saved",
  );
  await writerEdit(rooms, documentId, (current) => current.slice(0, -1));
  check(
    !(await liveMarkdown(rooms, documentId)).includes("The AI adds this."),
    "a removal that read the AI's text stands",
  );

  const emptyDraft = "probe0000002";
  await raw`insert into drafts(id,project_id,created_by) values (${emptyDraft},${project},${user})`;
  const emptyFork = { kind: "fork", draftId: emptyDraft, documentId } as const;
  const writer = await rooms.read(emptyFork, { peer: freshPeerId() });
  const writerBase = writer.version();
  writeDocument(
    writer,
    blocksOf(
      withBlockIds(
        schema.topNodeType.create(null, [
          ...readDocument(writer).map((block) => nodeOf(schema, block)),
          schema.nodes.paragraph.create(null, schema.text("Soon discarded.")),
        ]),
      ),
    ),
  );
  await rooms.write(emptyFork, encodeEnvelope(writer.exportSince(writerBase)), "probe:tab");
  writer.free();
  await rooms.flush(emptyFork);
  check((await forkRow(emptyDraft))?.pending === true, "a second draft's fork is pending");
  const discard = await rooms.read(emptyFork);
  const discardBase = discard.version();
  discardBlocks(discard, "all", { by: { press: "probe-discard" } });
  await rooms.commit(
    db,
    emptyFork,
    encodeEnvelope(discard.exportSince(discardBase)),
    "press:probe",
  );
  discard.free();
  check((await forkRow(emptyDraft))?.pending === false, "a Discard of every change clears pending");
  await rooms.unload(live);
  await raw`update document_forks set checked_at = now() - interval '40 days',
    empty_since = case when pending then null else now() - interval '40 days' end
    where document_id = ${documentId}`;
  const retired = await rooms.retireEmptyForks();
  const emptyRows = await rows(`fork:${emptyDraft}:${documentId}`);
  const kept = await raw<{ fresh: boolean }[]>`
    select checked_at > now() - interval '1 hour' as fresh from document_forks
    where draft_id = ${draftId} and document_id = ${documentId}`;
  check(
    retired === 1 && !(await forkRow(emptyDraft)) && emptyRows.length === 0,
    "a fork empty for 30 days is deleted with its rows",
  );
  check(kept[0]?.fresh === true, "a pending fork read again stays, its flag fresh");
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
