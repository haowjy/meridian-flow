/**
 * Decisions D20 and D22 item 2: a live pull fenced by a settlement re-arms its debounce only
 * while that settlement is `pending`. A terminally `blocked` batch never lifts by itself, so a
 * pull it fences answers `blocked` and stops: one capture, not one per debounce period forever.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createDraftPullService } from "../../../../apps/server/server/domains/collab/domain/draft-pulls.ts";
import { observe, type Probe, Y } from "./harness.mts";

const DEBOUNCE_MS = 10;
const OBSERVE_MS = 250;

export const d20BlockedSettlementPull: Probe = {
  name: "d20-blocked-settlement-pull",
  decision: "D20, D22",
  expected: "pending: captures keep growing (re-armed); blocked: one capture; revision 0 both",
  async run(harness) {
    for (const state of ["pending", "blocked"] as const) {
      const { branchId } = await harness.seedWork(`settlement-${state}`);
      const { documentId, live } = await harness.seedDocument(`settlement-${state}`);
      const documentDraft = await harness.store.ensureDocumentDraft({
        documentId,
        branchId,
        liveDoc: live,
      });
      const batchId = randomUUID();
      await harness.raw`insert into branch_push_settlement_batches(id,state,blocked_at,last_error_code)
        values (${batchId},${state},${state === "blocked" ? new Date() : null},${state === "blocked" ? "corrupt_settlement_authority" : null})`;
      const [push] = await harness.raw<{ id: string }[]>`
        insert into push_lineage(draft_id,draft_generation,document_id,journal_ids,idempotency_key)
        values (${documentDraft.draftId},${documentDraft.generation},${documentId},'{}',${randomUUID()}) returning id`;
      const bytes = Buffer.from(Y.encodeStateAsUpdate(live));
      await harness.raw`insert into branch_push_settlement_outbox(push_id,batch_id,document_id,document_title,lock_cut_update,push_update,trail_seed)
        values (${push?.id ?? ""},${batchId},${documentId},${state},${bytes},${bytes},'{}')`;
      let captures = 0;
      const pulls = createDraftPullService({
        outsideTransaction: (operation) => operation(),
        drafts: harness.store,
        draftCoordinator: harness.coordinator,
        debounceMs: DEBOUNCE_MS,
        liveCoordinator: {
          async withDocument(id: string, run: (doc: Y.Doc) => unknown) {
            captures += 1;
            const doc = await harness.liveDoc(id);
            try {
              return await run(doc);
            } finally {
              doc.destroy();
            }
          },
          async recover() {},
        } as never,
      });
      try {
        await pulls.flushLivePull(documentId);
        await new Promise((done) => setTimeout(done, OBSERVE_MS));
        const after = await harness.readDraft(documentDraft.draftId);
        observe(state, { captures, revision: after.revision });
        assert.equal(after.revision, 0);
        if (state === "pending") assert.ok(captures > 2, "a pending settlement re-arms the pull");
        else assert.equal(captures, 1, "a blocked settlement does not re-arm the pull");
      } finally {
        pulls.cancelScheduledPulls();
        live.destroy();
      }
    }
  },
};
