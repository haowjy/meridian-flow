/**
 * Decision D22 item 1 (re-gate F2/RS1): a peer pull whose drafts are retracted between capture
 * and commit ends in its typed loss: the upstream check answers `upstreamMoved` under its row lock, so
 * `pullThreadPeer` reports `ThreadPeerPullLost`, the error staged writes classify as a discarded
 * document.
 */
import assert from "node:assert/strict";
import type { ThreadId } from "@meridian/contracts/runtime";
import { createDraftCoordinator } from "../../../../apps/server/server/domains/collab/domain/draft-coordinator.ts";
import { createDraftPullService } from "../../../../apps/server/server/domains/collab/domain/draft-pulls.ts";
import { independently, observe, type Probe, settled } from "./harness.mts";

export const d22RetractedPeerPull: Probe = {
  name: "d22-retracted-peer-pull",
  decision: "D22",
  expected:
    "retraction `retracted`; the pull's upstream check answers `upstreamMoved`; the pull rejects `ThreadPeerPullLost`",
  async run(harness) {
    const { branchId, threadId } = await harness.seedWork("retracted-peer");
    const { documentId, live } = await harness.seedDocument("retracted-peer");
    await harness.store.ensureDocumentDraft({ documentId, branchId, liveDoc: live });
    const outcomes: string[] = [];
    let retraction: string | undefined;
    const coordinator = createDraftCoordinator({
      onAppendCommitted: () => {},
      attemptScope: harness.attemptScope,
      store: {
        ...harness.store,
        async commitRewrite(input) {
          if (retraction === undefined) {
            const result = await independently(() =>
              harness.projection.mutate({ branches: [branchId] }, () =>
                harness.store.retractCreatedDocumentDraft({ documentId, branchId }),
              ),
            );
            retraction = result;
          }
          const outcome = await harness.store.commitRewrite(input);
          outcomes.push(outcome.status);
          return outcome;
        },
      },
    });
    const pulls = createDraftPullService({
      outsideTransaction: independently,
      drafts: harness.store,
      liveJournal: harness.persistence.journal,
      draftCoordinator: coordinator,
      liveCoordinator: {
        withDocument: async (_id: string, run: (doc: typeof live) => unknown) => run(live),
      } as never,
    });
    try {
      const pull = await settled(
        pulls.pullThreadPeer({ documentId, threadId: threadId as ThreadId, branchId }),
      );
      observe("retracted", { retraction, outcomes, pull });
      assert.equal(retraction, "retracted");
      assert.equal(outcomes.at(-1), "upstreamMoved");
      assert.equal(pull.ok, false);
      assert.equal(pull.ok ? undefined : pull.name, "ThreadPeerPullLost");
    } finally {
      pulls.cancelScheduledPulls();
      live.destroy();
    }
  },
};
