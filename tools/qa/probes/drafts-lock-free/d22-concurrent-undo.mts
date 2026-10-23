/**
 * Decision D22 item 5: two Undos of the same model write, started together on independent
 * connections, land once. The inverse orders them by what it captured (the draft's revision under
 * its exact checkpoint rewrite, the live head under the document's mutation lock), not by a
 * `document-inverse` advisory lock: the second misses, recaptures, sees the write already undone,
 * and records nothing. Both destinations: a live document and a Work draft.
 */
import assert from "node:assert/strict";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { captureReceiptRows } from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-edits.ts";
import { createDrizzleTurnInverseService } from "../../../../apps/server/server/domains/collab/adapters/drizzle-turn-inverse.ts";
import { materializeDraftRead } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import { createAllowAllFileAccess } from "../../../../apps/server/server/domains/file-policy/index.ts";
import { runWithEditConfirmation } from "../../../../apps/server/server/shared/edit-confirmation.ts";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import { seedModelLiveWrite, workGrant } from "./f1-inverse-grant.mts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  type Probe,
  settled,
  Y,
} from "./harness.mts";

/** A Work draft of a live document carrying one committed model write, ready to Undo. */
async function seedModelDraftWrite(harness: Harness, label: string) {
  const work = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const documentDraft = await harness.store.ensureDocumentDraft({
    documentId,
    branchId: work.branchId,
    liveDoc: live,
    liveRoom: null,
  });
  const read = await harness.store.readDraftAt(documentDraft.draftId);
  if (!read) throw new Error("The document draft was not created");
  live.destroy();
  const draft = materializeDraftRead(read);
  draft.clientID = 941_002;
  const before = Y.encodeStateAsUpdate(draft);
  const update = appendToFirstParagraph(draft, " agent");
  draft.destroy();
  const wId = await harness.persistence.journal.reserveWriteOrdinal(documentId, work.threadId);
  const pre = new Y.Doc({ gc: false });
  Y.applyUpdate(pre, before);
  let parts: ReturnType<typeof captureReceiptRows>;
  try {
    parts = captureReceiptRows(pre, [
      {
        update,
        origin: { kind: "pending", draftId: documentDraft.draftId, rowId: 0 },
      },
    ]);
  } finally {
    pre.destroy();
  }
  const row = {
    draftId: documentDraft.draftId,
    updateData: update,
    source: "agent" as const,
    threadId: work.threadId as ThreadId,
    turnId: work.turnId,
    wId,
  };
  const receipts = [{ rowIndexes: [0], parts: parts.map(({ origin: _origin, ...part }) => part) }];
  const appended = await harness.store.appendRows({
    draftId: documentDraft.draftId,
    documentId,
    base: {
      checkpointRevision: read.documentDraft.checkpointRevision,
      seq: read.documentDraft.checkpointSeq,
    },
    finalize: () => ({ status: "appended", rows: [row], receipts }),
  });
  if (appended.status !== "appended") throw new Error(`The model write was ${appended.status}`);
  return { ...work, documentId, draftId: documentDraft.draftId };
}

function inverseService(harness: Harness, handle: string) {
  return createDrizzleTurnInverseService({
    fileAccess: createAllowAllFileAccess(),
    onDraftCommitted: () => {},
    db: harness.db,
    journal: harness.persistence.journal,
    drafts: harness.store,
    coordinator: {
      withDocument: async <T,>(id: string, run: (doc: Y.Doc) => Promise<T>) => {
        const doc = await harness.liveDoc(id);
        try {
          return await run(doc);
        } finally {
          doc.destroy();
        }
      },
      recover: async () => {},
      deliver: async () => {},
    } as never,
    draftCoordinator: { async deliverCommitted() {} },
    resolveDocumentUri: async () => `scratch://@${handle}/probe.md`,
    refreshDocument: async () => {},
    flushLivePull: async () => {},
    notices: { record: async () => {} },
    workProjection: harness.projection,
    removal: createTestDocumentRemoval(harness.db),
    catalog: { refreshSources: async () => "" },
  });
}

async function editKinds(harness: Harness, documentId: DocumentId): Promise<string[]> {
  const rows = await harness.raw<{ kind: string }[]>`
    select kind from document_edits where document_id = ${documentId} order by created_at, id`;
  return rows.map((row) => row.kind);
}

/**
 * Two Undos of `undo`, each on its own connection, both planned before either enters its commit
 * scope (a barrier at `inverse.beforeCommitScope` on their first attempts); their statuses.
 */
async function twoUndos(
  harness: Harness,
  workId: string,
  undo: () => Promise<{ status: string }>,
): Promise<string[]> {
  const grant = workGrant(harness, workId);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  const remove = setTestHook("inverse.beforeCommitScope", async () => {
    arrived += 1;
    if (arrived === 2) release();
    if (arrived <= 2) await barrier;
  });
  const results = await Promise.all(
    [0, 1].map(() =>
      settled(independently(() => runWithEditConfirmation(grant, undo))).then((result) =>
        result.ok ? result.value.status : `${result.name}${result.code ? ` ${result.code}` : ""}`,
      ),
    ),
  ).finally(remove);
  if (arrived < 2) throw new Error("The two Undos never planned together");
  return results.sort();
}

export const d22ConcurrentUndo: Probe = {
  name: "d22-concurrent-undo",
  decision: "D22",
  expected:
    "live and draft: one `success`, one refusal; kinds `write, undo`; the text reverted once; no `40P01`",
  async run(harness) {
    {
      const seeded = await seedModelLiveWrite(harness, "two-undo-live");
      const statuses = await twoUndos(harness, seeded.workId, seeded.undo);
      const kinds = await editKinds(harness, seeded.documentId);
      const text = await harness.liveText(seeded.documentId);
      observe("live", { statuses, kinds, text });
      assert.equal(statuses.filter((status) => status === "success").length, 1);
      assert.ok(
        statuses.every((status) => !/Error/.test(status)),
        statuses.join(", "),
      );
      assert.deepEqual(kinds, ["write", "undo"]);
      assert.equal(text, "<paragraph>Base</paragraph>");
    }
    {
      const seeded = await seedModelDraftWrite(harness, "two-undo-draft");
      const inverse = inverseService(harness, seeded.handle);
      const undo = () =>
        inverse.modelInverse(
          {
            threadId: seeded.threadId,
            turnId: seeded.turnId,
            documentIds: [seeded.documentId],
            draftId: seeded.draftId,
            model: true,
          } as never,
          { command: "undo", file: "probe.md" },
        );
      const statuses = await twoUndos(harness, seeded.workId, undo);
      const kinds = await editKinds(harness, seeded.documentId);
      const draft = await harness.readDraft(seeded.draftId);
      observe("draft", { statuses, kinds, text: draft.text, revision: draft.revision });
      assert.equal(statuses.filter((status) => status === "success").length, 1);
      assert.ok(
        statuses.every((status) => !/Error/.test(status)),
        statuses.join(", "),
      );
      assert.deepEqual(kinds, ["write", "undo"]);
      assert.equal(draft.text, "<paragraph>Base</paragraph>");
    }
  },
};
