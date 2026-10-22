/**
 * Final-gate F1: a model Undo is a grant seam. Its first locks are the bound grants' Works, in id
 * order with the captured drafts' Works, and the grants are confirmed before any inverse or
 * document lock. A live-only inverse (a named Work's Scratch) captures no draft, so the grant is
 * its only route to the Work. Two orders against Archive on an independent connection:
 *
 * - lifecycle first: Archive commits before the inverse's commit scope; the confirmation, read
 *   under the Work lock, sees it and the Undo writes nothing;
 * - inverse first: the confirmation holds the Work row, so Archive waits on it until the Undo
 *   commits, and only then archives.
 */
import assert from "node:assert/strict";
import type { DocumentId } from "@meridian/contracts/runtime";
import { sql } from "drizzle-orm";
import {
  captureReceiptRows,
  recordDocumentEdit,
} from "../../../../apps/server/server/domains/collab/adapters/drizzle-document-edits.ts";
import { createDrizzleTurnInverseService } from "../../../../apps/server/server/domains/collab/adapters/drizzle-turn-inverse.ts";
import {
  currentDrizzleDb,
  runInRootDrizzleTransaction,
} from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import {
  type EditConfirmation,
  runWithEditConfirmation,
} from "../../../../apps/server/server/shared/edit-confirmation.ts";
import { setTestHook } from "../../../../apps/server/server/shared/test-hooks.ts";
import { createTestDocumentRemoval } from "../../../../apps/server/server/test-support/document-removal.ts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  type Probe,
  settled,
  Y,
} from "./harness.mts";

/** A Work-owned live document carrying one committed model write, ready to Undo. */
export async function seedModelLiveWrite(harness: Harness, label: string) {
  const work = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const before = Y.encodeStateAsUpdate(live);
  live.clientID = 941_001;
  const update = appendToFirstParagraph(live, " agent");
  live.destroy();
  await runInRootDrizzleTransaction(harness.db, async () => {
    const seq = await harness.persistence.journal.append(documentId, update, {
      origin: "system",
      seq: 0,
    });
    const wId = await harness.persistence.journal.reserveWriteOrdinal(documentId, work.threadId);
    const pre = new Y.Doc({ gc: false });
    Y.applyUpdate(pre, before);
    try {
      await recordDocumentEdit(currentDrizzleDb(harness.db), {
        documentId,
        threadId: work.threadId as never,
        turnId: work.turnId as never,
        actor: "agent",
        wId,
        receipts: captureReceiptRows(pre, [{ update, origin: { kind: "live", seq } }]),
      });
    } finally {
      pre.destroy();
    }
  });
  const inverse = createDrizzleTurnInverseService({
    onDraftCommitted: () => {},
    db: harness.db,
    journal: harness.persistence.journal,
    drafts: harness.store,
    initializeEmptyDocument: harness.initializeEmptyDocument,
    // The live coordinator's room is a fresh read of the journal; delivery is inert.
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
    resolveDocumentUri: async () => `scratch://@${work.handle}/probe.md`,
    refreshDocument: async () => {},
    flushLivePull: async () => {},
    notices: { record: async () => {} },
    workProjection: harness.projection,
    removal: createTestDocumentRemoval(harness.db),
    catalog: { refreshSources: async () => "" },
  });
  const undo = () =>
    inverse.modelInverse(
      {
        threadId: work.threadId,
        turnId: work.turnId,
        documentIds: [documentId],
        draftId: null,
        model: true,
      } as never,
      { command: "undo", file: "probe.md" },
    );
  return { ...work, documentId, undo };
}

/** The bound grant: names the Work, and refuses under the seam's lock once it is archived. */
export function workGrant(
  harness: Harness,
  workId: string,
  onConfirm?: () => Promise<void>,
): EditConfirmation & { confirmations: number } {
  const grant = {
    workIds: [workId],
    confirmations: 0,
    covers: async () => true,
    async confirm() {
      grant.confirmations += 1;
      // The policy's lifecycle check (file-access §5), read in the seam's transaction.
      const [work] = await currentDrizzleDb(harness.db).execute<{ archived: boolean }>(
        sql`select archived_at is not null as archived from works where id = ${workId}`,
      );
      if (work?.archived) throw new Error(`Grant refused: Work ${workId} is archived`);
      await onConfirm?.();
    },
  };
  return grant;
}

async function editKinds(harness: Harness, documentId: DocumentId): Promise<string[]> {
  const rows = await harness.raw<{ kind: string }[]>`
    select kind from document_edits where document_id = ${documentId} order by created_at, id`;
  return rows.map((row) => row.kind);
}

export const f1InverseGrant: Probe = {
  name: "f1-inverse-grant",
  decision: "final-gate F1, D17",
  expected:
    "lifecycle first: the Undo is refused and writes nothing; inverse first: Archive waits on the Work row and commits after the Undo",
  async run(harness) {
    // Lifecycle first: Archive commits after the inverse planned and before its commit scope.
    {
      const seeded = await seedModelLiveWrite(harness, "grant-lifecycle-first");
      const grant = workGrant(harness, seeded.workId);
      const remove = setTestHook("inverse.beforeCommitScope", async () => {
        await independently(() => harness.works.archive(seeded.workId));
      });
      const outcome = await settled(
        runWithEditConfirmation(grant, seeded.undo).finally(remove),
      ).then((result) => (result.ok ? { ok: true, status: result.value.status } : result));
      const kinds = await editKinds(harness, seeded.documentId);
      const text = await harness.liveText(seeded.documentId);
      observe("lifecycle first", { outcome, confirmations: grant.confirmations, kinds, text });
      assert.equal(await harness.workArchived(seeded.workId), true);
      assert.ok(!("status" in outcome) || outcome.status !== "success", "the Undo must not land");
      assert.deepEqual(kinds, ["write"]);
      assert.match(text, /Base agent/);
    }
    // Inverse first: the confirmation holds the Work row; Archive starts and must wait on it.
    {
      const seeded = await seedModelLiveWrite(harness, "grant-inverse-first");
      let archive: Promise<unknown> | undefined;
      let waiting: string[] = [];
      let archivedWhileHeld: boolean | undefined;
      const grant = workGrant(harness, seeded.workId, async () => {
        archive = independently(() => harness.works.archive(seeded.workId));
        waiting = await harness.waitForLockWaiter(/works/);
        archivedWhileHeld = await harness.workArchived(seeded.workId);
      });
      const result = await runWithEditConfirmation(grant, seeded.undo);
      const archived = await settled(archive ?? Promise.resolve());
      const kinds = await editKinds(harness, seeded.documentId);
      observe("inverse first", {
        archiveWaitedOn: waiting,
        archivedWhileHeld,
        undo: result.status,
        archive: archived.ok,
        archivedAfter: await harness.workArchived(seeded.workId),
        confirmations: grant.confirmations,
        kinds,
      });
      assert.ok(waiting.length > 0);
      assert.equal(archivedWhileHeld, false);
      assert.equal(result.status, "success");
      assert.equal(archived.ok, true);
      assert.equal(await harness.workArchived(seeded.workId), true);
      assert.equal(grant.confirmations, 1);
      assert.deepEqual(kinds, ["write", "undo"]);
    }
  },
};
