/**
 * Decision D13: one attempt owns every candidate it prepared. Two prepared catch-ups in one
 * attempt: the first persists, then an independent pull moves the second's draft, so the
 * second misses. The attempt's scope rolls the first write back, and both candidates are
 * destroyed, the successful one included (the defect was "persisted, so dispose does nothing").
 */
import assert from "node:assert/strict";
import { runBoundedAttempts } from "../../../../apps/server/server/domains/collab/domain/draft-attempts.ts";
import { DraftCasConflictError } from "../../../../apps/server/server/domains/collab/domain/draft-store.ts";
import {
  appendToFirstParagraph,
  independently,
  observe,
  type Probe,
  paragraphDoc,
} from "./harness.mts";

export const d13CandidateDisposal: Probe = {
  name: "d13-candidate-disposal",
  decision: "D13",
  expected: "the second write misses; the first is rolled back; both candidates emit `destroy`",
  async run(harness) {
    const { branchId } = await harness.seedWork("candidate-disposal");
    const a = await harness.seedDocument("candidate-a", "Base");
    const b = await harness.seedDocument("candidate-b", "Base");
    const draftA = await harness.store.ensureDocumentDraft({ ...a, branchId, liveDoc: a.live });
    const draftB = await harness.store.ensureDocumentDraft({ ...b, branchId, liveDoc: b.live });
    const source = paragraphDoc("Base");
    appendToFirstParagraph(source, " caught up");
    const destroyed = { first: false, second: false };
    const before = await harness.readDraft(draftA.draftId);
    try {
      const outcome = await runBoundedAttempts({
        bound: 1,
        scope: harness.attemptScope,
        isMiss: (cause) => cause instanceof DraftCasConflictError,
        async run(attempt) {
          const first = await harness.coordinator.prepareCatchUp(draftA.draftId, source);
          const second = await harness.coordinator.prepareCatchUp(draftB.draftId, source);
          if (!first || !second) throw new Error("both drafts lack the source");
          attempt.own(first);
          attempt.own(second);
          first.candidate.on("destroy", () => {
            destroyed.first = true;
          });
          second.candidate.on("destroy", () => {
            destroyed.second = true;
          });
          return attempt.commit(async () => {
            await first.persist();
            b.live.getMap("probe").set("moved", true);
            await independently(() =>
              harness.coordinator.pullFromDoc({ draftId: draftB.draftId, upstream: b.live }),
            );
            await second.persist();
            return "committed";
          });
        },
        exhausted: (cause) => `missed: ${(cause as Error).name}`,
      });
      const after = await harness.readDraft(draftA.draftId);
      observe("attempt", { outcome, destroyed, firstRevision: [before.revision, after.revision] });
      assert.equal(outcome, "missed: DraftCasConflictError");
      assert.deepEqual(destroyed, { first: true, second: true });
      assert.equal(after.revision, before.revision);
      assert.doesNotMatch(after.text, /caught up/);
    } finally {
      source.destroy();
      a.live.destroy();
      b.live.destroy();
    }
  },
};
