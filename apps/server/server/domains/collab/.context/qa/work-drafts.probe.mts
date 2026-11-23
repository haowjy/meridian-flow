/**
 * A Work's drafts on a scratch database, through the production adapters: `Delete draft` and its
 * Undo, `setChatDraft` racing a delete, the purge racing a fork room's save, and a chat move
 * recounting both Works. Recipe: `work-drafts.md` beside this file.
 *
 *   pnpm dev:infra
 *   node --import tsx apps/server/server/domains/collab/.context/qa/work-drafts.probe.mts
 */
import type { DraftId, ThreadId, WorkId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";
import { encodeEnvelope, freshPeerId, readDocument, writeDocument } from "@meridian/document-model";
import { blocksOf, nodeOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  packCollabSchemaVersion,
  withBlockIds,
} from "@meridian/prosemirror-schema";
import {
  createScratchDatabase,
  openHarness,
} from "../../../../../../../tools/qa/probes/model-edit-harness/scratch.mts";
import { createDrizzleTreeListStore } from "../../../context/adapters/drizzle-tree-list-store.ts";
import { createNoopEventSink } from "../../../observability/index.ts";
import { createDrizzleThreadWorksRepository } from "../../../threads/adapters/drizzle/thread-works-repository.ts";
import { createTestWorkProjectionMutation } from "../../../../test-support/work-projection.ts";
import { createDrizzleWorkDrafts } from "../../adapters/drizzle-work-drafts.ts";
import { createPostgresDocumentRooms } from "../../rooms/postgres-document-rooms.ts";

const failures: string[] = [];
const check = (ok: boolean, what: string, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const schema = buildDocumentSchema();
const scratch = await createScratchDatabase();
const h = await openHarness(scratch.url);
const { db, raw } = h;
// A loaded room set, as the server holds one: the purge ends its rooms, and a tab's typing
// waits in it for the debounced save.
const rooms = createPostgresDocumentRooms({
  db,
  shape: shapeSchemaOf(schema),
  eventSink: createNoopEventSink(),
  schemaVersion: packCollabSchemaVersion(COLLAB_SCHEMA_VERSION),
});
const workProjection = createTestWorkProjectionMutation(db);
const treeLists = createDrizzleTreeListStore({ db });
const drafts = createDrizzleWorkDrafts(db, {
  workProjection,
  treeLists,
  endRooms: (ended) => rooms.endRooms(ended),
});
const threadWorks = createDrizzleThreadWorksRepository(db, workProjection);

/** A tab types a closing paragraph into the draft's fork of the document; unsaved until `flush`. */
async function typeInFork(draftId: DraftId, documentId: DocumentId, text: string) {
  const fork = { kind: "fork", draftId, documentId } as const;
  const tab = await rooms.read(fork, { peer: freshPeerId() });
  try {
    const since = tab.shownVersion();
    const blocks = readDocument(tab).map((block) => nodeOf(schema, block));
    blocks.push(schema.nodes.paragraph.create(null, schema.text(text)));
    writeDocument(tab, blocksOf(withBlockIds(schema.topNodeType.create(null, blocks))));
    await rooms.write(fork, encodeEnvelope(tab.exportSince(since)), "probe:tab");
  } finally {
    tab.free();
  }
  return fork;
}
const chatDraft = async (threadId: string) =>
  (await raw<{ d: string }[]>`select draft_id as d from threads where id = ${threadId}`)[0]?.d;
const forkRows = async (draftId: string, documentId: string) =>
  Number(
    (
      await raw<{ n: string }[]>`
        select count(*)::text as n from document_snapshots
        where room_key = ${`fork:${draftId}:${documentId}`}`
    )[0]?.n,
  );
const forkRow = async (draftId: string, documentId: string) =>
  (
    await raw<{ pending: boolean }[]>`
      select pending from document_forks where draft_id = ${draftId} and document_id = ${documentId}`
  )[0];
const workCount = async (workId: string) =>
  (await raw<{ n: number }[]>`select pending_document_count as n from works where id = ${workId}`)[0]
    ?.n;

try {
  const a = await h.seedWork("Rewrite");
  const { documentId } = await h.seedDocument("chapter", "Opening.");

  // Delete draft and its Undo.
  const second = await drafts.create({ workId: a.workId, name: "Second", userId: h.ids.user });
  if (!second) throw new Error("the Work takes a second draft");
  check(
    (await drafts.setChatDraft({ threadId: a.threadId as ThreadId, draftId: second.id })) ===
      second.id,
    "setChatDraft names one of the Work's drafts",
  );
  await drafts.remove({ workId: a.workId, draftId: second.id, userId: h.ids.user });
  check(
    !(await drafts.list(a.workId)).some((draft) => draft.id === second.id),
    "Delete draft lists the draft nowhere",
  );
  check((await chatDraft(a.threadId)) === a.draftId, "a chat on a deleted draft names the default");
  check(
    (await drafts.setChatDraft({ threadId: a.threadId as ThreadId, draftId: second.id })) ===
      a.draftId,
    "setChatDraft does not name a deleted draft",
  );
  const back = await drafts.restore({ workId: a.workId, draftId: second.id });
  check(back?.id === second.id, "its Undo lists the draft again");
  check((await chatDraft(a.threadId)) === a.draftId, "the Undo leaves the chat where it is");

  // setChatDraft against a delete of the same draft: the chat never names a deleted draft.
  let named = 0;
  for (let round = 0; round < 25; round++) {
    await drafts.restore({ workId: a.workId, draftId: second.id });
    await raw`update threads set draft_id = ${a.draftId} where id = ${a.threadId}`;
    await Promise.all([
      drafts.setChatDraft({ threadId: a.threadId as ThreadId, draftId: second.id }),
      drafts.remove({ workId: a.workId, draftId: second.id, userId: h.ids.user }),
    ]);
    const [row] = await raw<{ deleted: boolean }[]>`
      select d.deleted_at is not null as deleted from threads t join drafts d on d.id = t.draft_id
      where t.id = ${a.threadId}`;
    if (row?.deleted) named++;
  }
  check(named === 0, "25 races of setChatDraft and Delete draft: no chat names a deleted draft", {
    named,
  });

  // The purge against a fork room's save of a tab's typing.
  const fork = await typeInFork(second.id, documentId, "Typed before the purge.");
  await rooms.flush(fork);
  check((await forkRow(second.id, documentId))?.pending === true, "the draft's fork is pending");
  await drafts.remove({ workId: a.workId, draftId: second.id, userId: h.ids.user });
  await raw`update drafts set deleted_at = now() - interval '31 days' where id = ${second.id}`;
  await typeInFork(second.id, documentId, "Typed while the purge runs.");
  const [purged, saved] = await Promise.allSettled([
    drafts.purgeDeleted(),
    rooms.flush(fork),
  ]);
  check(
    purged.status === "fulfilled" && purged.value === 1,
    "the purge takes the draft deleted 31 days ago",
    purged.status === "rejected" ? String(purged.reason) : purged.value,
  );
  check(saved.status === "fulfilled", "the racing save settles", saved.status === "rejected" ? String(saved.reason) : undefined);
  check(
    (await raw`select 1 from drafts where id = ${second.id}`).length === 0 &&
      (await forkRow(second.id, documentId)) === undefined &&
      (await forkRows(second.id, documentId)) === 0,
    "the draft, its fork row and its fork's rows are gone",
  );
  await typeInFork(second.id, documentId, "Typed after the purge.");
  await rooms.flush(fork);
  check(
    (await forkRow(second.id, documentId)) === undefined &&
      (await forkRows(second.id, documentId)) === 0,
    "a save for a purged draft writes nothing",
  );

  // A chat move carries its draft and recounts both Works.
  const b = await h.seedWork("Elsewhere");
  await typeInFork(a.draftId, documentId, "Pending in the moving draft.");
  await rooms.flush({ kind: "fork", draftId: a.draftId, documentId });
  await workProjection.mutate({ works: [a.workId, b.workId] }, async () => undefined);
  check(
    (await workCount(a.workId)) === 1 && (await workCount(b.workId)) === 0,
    "before the move, the pending document counts in the chat's Work",
    { a: await workCount(a.workId), b: await workCount(b.workId) },
  );
  await raw`delete from threads where draft_id = ${a.draftId} and id <> ${a.threadId}`;
  await threadWorks.rebindPrimary(a.threadId as ThreadId, b.workId as WorkId);
  for (let i = 0; i < 40 && (await workCount(b.workId)) !== 1; i++) await sleep(50);
  check(
    (await chatDraft(a.threadId)) === a.draftId &&
      (await raw<{ w: string }[]>`select work_id as w from drafts where id = ${a.draftId}`)[0]?.w ===
        b.workId,
    "an unshared draft moves with its chat",
  );
  check(
    (await workCount(a.workId)) === 0 && (await workCount(b.workId)) === 1,
    "the move recounts both Works",
    { a: await workCount(a.workId), b: await workCount(b.workId) },
  );
} finally {
  await rooms.close().catch(() => {});
  await h.close();
  await scratch.drop();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
