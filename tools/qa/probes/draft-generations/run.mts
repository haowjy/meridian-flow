/** Stable draft identity through Discard, process loss and live authority replacement. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { draftRoomName, WS_CLOSE } from "@meridian/contracts/protocol";
import { createDrizzleBranchDiscard } from "../../../../apps/server/server/domains/collab/adapters/drizzle-branch-discard.ts";
import {
  readDocumentAuthorityHead,
  replaceGeneration,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-authority-head.ts";
import { createDraftClose } from "../../../../apps/server/server/domains/collab/adapters/drizzle-draft-close.ts";
import { createDraftRetirement } from "../../../../apps/server/server/domains/collab/domain/draft-retirement.ts";
import { closeDraftRooms } from "../../../../apps/server/server/domains/collab/hocuspocus-rooms.ts";
import { runInDrizzleTransaction } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import {
  appendToFirstParagraph,
  createScratchDatabase,
  observe,
  openHarness,
  Y,
} from "../drafts-lock-free/harness.mts";
import { openGateway } from "../drafts-lock-free/room-enrollment.mts";

const scratch = await createScratchDatabase();
const h = await openHarness(scratch.url);
let server = openGateway(h, h.store);
try {
  const work = await h.seedWork("g2");
  const { documentId, live } = await h.seedDocument("g2", "Base");
  const draft = await h.store.ensureDocumentDraft({
    documentId,
    branchId: work.branchId,
    liveDoc: live,
  });
  live.destroy();
  const roomKey = draftRoomName(draft.draftId);
  let room = await server.load(draft.draftId);
  await server.enrolled(draft.draftId);
  // A version restore replaces live's authority, never the Work draft's identity.
  const head = await readDocumentAuthorityHead(h.db, documentId);
  await h.raw.unsafe(
    await readFile(
      new URL(
        "../../../../packages/database/src/functions/capture_document_checkpoint_range.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const liveNow = await h.liveDoc(documentId);
  liveNow.clientID = 900001;
  const update = appendToFirstParagraph(liveNow, " LIVE");
  await h.persistence.journal.appendWriterUpdate(
    documentId,
    update,
    { origin: `human:${h.ids.user}`, seq: 0 },
    head,
  );
  liveNow.destroy();
  const cut = await h.persistence.journal.captureCheckpoint(documentId, head);
  assert(cut);
  await h.persistence.journal.storeCheckpoint(cut);
  const [checkpoint] =
    await h.raw`select id from document_yjs_checkpoints where document_id=${documentId} order by id desc limit 1`;
  assert(checkpoint);
  const checkpointId = Number(checkpoint.id);
  const restored = await replaceGeneration(h.db, {
    documentId,
    checkpointId,
    expectedGeneration: head.generation,
  });
  assert(restored.ok);
  assert.equal(restored.generation, head.generation + 1n);
  assert.equal(room.name, roomKey);
  assert.equal((await h.store.getDraft(draft.draftId))?.status, "active");
  observe("live restore", { live: String(restored.generation), room: room.name });

  const offline = new Y.Doc({ gc: false });
  Y.applyUpdate(offline, Y.encodeStateAsUpdate(room));
  offline.clientID = 900123;
  const u1 = appendToFirstParagraph(offline, "A");
  const u2 = appendToFirstParagraph(offline, "B");
  const missing = await server.send(room, draft.draftId, u2);
  assert.deepEqual(missing, { ok: false, closes: [WS_CLOSE.DRAFT_PREFIX_MISSING] });
  observe("prefix missing", missing);
  offline.destroy();
  // Process-local room state is disposable: the next server materializes the same journal.
  await server.type(room, draft.draftId, " BEFORE RESTART");
  const before = (await h.readDraft(draft.draftId)).text;
  await server.close();
  server = openGateway(h, h.store);
  room = await server.load(draft.draftId);
  await server.enrolled(draft.draftId);
  assert.equal(room.name, roomKey);
  assert.equal(room.getXmlFragment("prosemirror").toString(), before);
  observe("new server", { room: room.name, text: before });
  const uploaded = await server.send(room, draft.draftId, Y.mergeUpdates([u1, u2]), 1);
  assert.deepEqual(uploaded, { ok: true, closes: [] });
  assert.match((await h.readDraft(draft.draftId)).text, /AB/);
  observe("reconnect uploads missing prefix", uploaded);

  const closes: { code: number; reason: string }[] = [];
  const connection = {
    context: { closeTransport: (close: { code: number; reason: string }) => closes.push(close) },
    close() {},
    send() {},
    readOnly: false,
    socketId: "other-tab",
  };
  room.addConnection(connection as never);
  const close = createDraftClose();
  close.bindRetirement(
    createDraftRetirement({
      closeDraftRoom: (id) => closeDraftRooms(server.hocuspocus, id),
      closeRemovedRooms: async () => {},
      agentEdit: { retireThreadPeers: async () => {} },
    }),
    (cause) => {
      throw cause;
    },
  );
  const discard = createDrizzleBranchDiscard(h.db, {
    close,
    branches: h.branches,
    workProjection: h.projection,
    removal: createTestDocumentRemoval(h.db),
    catalog: { refreshSources: async () => "0" },
  });
  await runInDrizzleTransaction(h.db, async () => {
    await discard.discardLocked({
      workId: work.workId,
      kernel: { branchId: work.branchId, selection: { kind: "whole" } },
    });
    assert.equal(closes.length, 0, "close must not escape before root commit");
  });
  assert.deepEqual(closes, [WS_CLOSE.DRAFT_CLOSED]);
  assert.equal((await h.store.getDraft(draft.draftId))?.closedCause, "discarded");
  room.removeConnection(connection as never);
  observe("Discard all other tab after commit", closes);
  console.log("PASS G2 stable draft identity and terminal close");
} finally {
  await server.close();
  await h.close();
  await scratch.drop();
}
