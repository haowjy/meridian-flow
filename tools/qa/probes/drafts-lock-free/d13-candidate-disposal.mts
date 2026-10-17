/**
 * Decision D13: one attempt owns every candidate it prepared. Two prepared catch-ups in one
 * attempt: the first persists, then an independent pull moves the second's branch, so the
 * second misses. The attempt's scope rolls the first write back, and both candidates are
 * destroyed, the successful one included (the defect was "persisted, so dispose does nothing").
 */
import assert from "node:assert/strict";
import { runBoundedAttempts } from "../../../../apps/server/server/domains/collab/domain/branch-attempts.ts";
import { BranchCasConflictError } from "../../../../apps/server/server/domains/collab/domain/branch-store.ts";
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
    const { draftId } = await harness.seedWork("candidate-disposal");
    const a = await harness.seedDocument("candidate-a", "Base");
    const b = await harness.seedDocument("candidate-b", "Base");
    const branchA = await harness.store.ensureDraftBranch({ ...a, draftId, liveDoc: a.live });
    const branchB = await harness.store.ensureDraftBranch({ ...b, draftId, liveDoc: b.live });
    const source = paragraphDoc("Base");
    appendToFirstParagraph(source, " caught up");
    const destroyed = { first: false, second: false };
    const before = await harness.readBranch(branchA.branchId);
    try {
      const outcome = await runBoundedAttempts({
        bound: 1,
        scope: harness.attemptScope,
        isMiss: (cause) => cause instanceof BranchCasConflictError,
        async run(attempt) {
          const first = await harness.coordinator.prepareCatchUp(branchA.branchId, source);
          const second = await harness.coordinator.prepareCatchUp(branchB.branchId, source);
          if (!first || !second) throw new Error("both branches lack the source");
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
              harness.coordinator.pullFromDoc({ branchId: branchB.branchId, upstream: b.live }),
            );
            await second.persist();
            return "committed";
          });
        },
        exhausted: (cause) => `missed: ${(cause as Error).name}`,
      });
      const after = await harness.readBranch(branchA.branchId);
      observe("attempt", { outcome, destroyed, firstRevision: [before.revision, after.revision] });
      assert.equal(outcome, "missed: BranchCasConflictError");
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
