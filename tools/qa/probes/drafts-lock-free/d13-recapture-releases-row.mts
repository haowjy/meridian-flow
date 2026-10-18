/**
 * Decision D13: a missed attempt leaves its commit scope, and with it every SQL lock it took,
 * before the next attempt captures. A pull's first attempt misses because an independent pull
 * moved the branch's checkpoint after the capture; when the second attempt captures, another
 * connection takes the branch row and the Work row `NOWAIT`. Two arms: each attempt its own root
 * transaction, and each attempt a savepoint inside the caller's ambient root.
 */
import assert from "node:assert/strict";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import type { DraftStore } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import { runInRootDrizzleTransaction } from "../../../../apps/server/server/shared/drizzle-transaction.ts";
import {
  appendToFirstParagraph,
  type Harness,
  independently,
  observe,
  type Probe,
} from "./harness.mts";

async function arm(harness: Harness, ambient: boolean) {
  const label = ambient ? "recapture-savepoint" : "recapture-root";
  const { workId, branchId } = await harness.seedWork(label);
  const { documentId, live } = await harness.seedDocument(label, "Base");
  const documentDraft = await harness.store.ensureDocumentDraft({
    documentId,
    branchId,
    liveDoc: live,
  });
  const outcomes: string[] = [];
  let rivalled = false;
  let missed = false;
  let recapture: unknown;
  const store: DraftStore = {
    ...harness.store,
    async commitRewrite(input) {
      if (!rivalled) {
        rivalled = true;
        // Another server's pull commits a checkpoint after this attempt captured.
        const rival = await independently(() =>
          harness.coordinator.pullFromDoc({ draftId: documentDraft.draftId, upstream: live }),
        );
        outcomes.push(`rival ${rival}`);
      }
      const outcome = await harness.store.commitRewrite(input);
      outcomes.push(outcome.status);
      if (outcome.status === "moved") missed = true;
      return outcome;
    },
    async readDraftAt(id, since) {
      if (missed && recapture === undefined) {
        recapture = await harness.raw
          .begin(async (tx) => {
            await tx`select id from document_drafts where id = ${documentDraft.draftId} for update nowait`;
            await tx`select id from works where id = ${workId} for no key update nowait`;
            return "branch and Work rows available";
          })
          .catch((cause: { code?: string }) => ({ held: cause.code }));
      }
      return harness.store.readDraftAt(id, since);
    },
  };
  const coordinator = createDraftCoordinator({
    onAppendCommitted: () => {},
    store,
    attemptScope: harness.attemptScope,
  });
  appendToFirstParagraph(live, " pulled");
  try {
    const pull = () => coordinator.pullFromDoc({ draftId: documentDraft.draftId, upstream: live });
    const result = ambient ? await runInRootDrizzleTransaction(harness.db, pull) : await pull();
    observe(ambient ? "savepoint per attempt" : "root per attempt", {
      outcomes,
      recapture,
      result,
    });
    assert.equal(result, "pulled");
    assert.ok(outcomes.includes("moved"), "the first attempt must miss");
    assert.equal(recapture, "branch and Work rows available");
  } finally {
    live.destroy();
  }
}

export const d13RecaptureReleasesRow: Probe = {
  name: "d13-recapture-releases-row",
  decision: "D13",
  expected:
    "after the first attempt misses, the second capture finds the branch and Work rows free (`NOWAIT`) in both arms",
  async run(harness) {
    await arm(harness, false);
    await arm(harness, true);
  },
};
