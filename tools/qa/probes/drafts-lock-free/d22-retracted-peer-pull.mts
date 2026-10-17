/**
 * Decision D22 item 1 (re-gate F2/RS1): a peer pull whose branches are retracted between capture
 * and commit ends in its typed loss: the commit answers `closed` under the row lock, so
 * `pullThreadPeer` reports `ThreadPeerPullLost`, the error staged writes classify as a discarded
 * document.
 */
import assert from "node:assert/strict";
import type { ThreadId } from "@meridian/contracts/runtime";
import { createBranchCoordinator } from "../../../../apps/server/server/domains/collab/domain/branch-coordinator.ts";
import { createBranchPullService } from "../../../../apps/server/server/domains/collab/domain/branch-pulls.ts";
import { independently, observe, type Probe, settled } from "./harness.mts";

export const d22RetractedPeerPull: Probe = {
  name: "d22-retracted-peer-pull",
  decision: "D22",
  expected:
    "retraction `retracted`; the pull's commit answers `closed`; the pull rejects `ThreadPeerPullLost`",
  async run(harness) {
    const { draftId, threadId } = await harness.seedWork("retracted-peer");
    const { documentId, live } = await harness.seedDocument("retracted-peer");
    await harness.store.ensureDraftBranch({ documentId, draftId, liveDoc: live });
    const outcomes: string[] = [];
    let retraction: string | undefined;
    const coordinator = createBranchCoordinator({
      attemptScope: harness.attemptScope,
      store: {
        ...harness.store,
        async commitRewrite(input) {
          if (retraction === undefined) {
            const result = await independently(() =>
              harness.projection.mutatePending({ drafts: [draftId] }, () =>
                harness.store.retractCreatedDraftBranch({ documentId, draftId }),
              ),
            );
            retraction = result.outcome;
          }
          const outcome = await harness.store.commitRewrite(input);
          outcomes.push(outcome.status);
          return outcome;
        },
      },
    });
    const pulls = createBranchPullService({
      outsideTransaction: independently,
      branches: harness.store,
      branchCoordinator: coordinator,
      liveCoordinator: {
        withDocument: async (_id: string, run: (doc: typeof live) => unknown) => run(live),
      } as never,
    });
    try {
      const pull = await settled(
        pulls.pullThreadPeer({ documentId, threadId: threadId as ThreadId, draftId }),
      );
      observe("retracted", { retraction, outcomes, pull });
      assert.equal(retraction, "retracted");
      assert.equal(outcomes.at(-1), "closed");
      assert.equal(pull.ok, false);
      assert.equal(pull.ok ? undefined : pull.name, "ThreadPeerPullLost");
    } finally {
      pulls.cancelScheduledPulls();
      live.destroy();
    }
  },
};
