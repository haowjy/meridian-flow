/** Focused contract coverage for post-completion branch-push broadcasts. */

import { createAgentEditCodecFactory, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createStaticDocumentLinkScopes } from "../adapters/in-memory/static-document-link-scopes.js";
import { testBranchRow } from "../test-support/stub-branch-store.js";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  PendingSettlementBatch,
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
} from "./branch-push-contracts.js";
import { createBranchPushTransition } from "./branch-push-transition.js";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";

const DOCUMENT_A = "00000000-0000-4000-8000-000000000001" as DocumentId;
const DOCUMENT_B = "00000000-0000-4000-8000-000000000002" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000003" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000004" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000005" as TurnId;

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);

function projectedChange(
  changeId: string,
  pushId: string,
  admittedByUserId: string | null,
  documentId = DOCUMENT_A,
): CommittedChangeTrailProjection["changes"][number] {
  return {
    changeId,
    ordinal: 0,
    documentId,
    pushId,
    receiptId: null,
    kind: "insert",
    beforeBlockIdentity: null,
    afterBlockIdentity: null,
    beforeText: null,
    afterTextAtReceipt: `${changeId}|${changeId} body`,
    navigation: { kind: "unavailable", reason: "fixture" },
    admittedByUserId,
  };
}

function projection(input: {
  revision: number;
  changes: CommittedChangeTrailProjection["changes"];
  documentId?: DocumentId;
  owner?: CommittedChangeTrailProjection["owner"];
}): CommittedChangeTrailProjection {
  return {
    trailId: "00000000-0000-4000-8000-000000000010",
    owner: input.owner ?? { kind: "turn", threadId: THREAD_ID, turnId: TURN_ID },
    documentId: input.documentId ?? DOCUMENT_A,
    projectionRevision: input.revision,
    changes: input.changes,
  };
}

function branch(documentId: DocumentId, _doc: Y.Doc): BranchSnapshot {
  return testBranchRow({ branchId: `branch-${documentId}`, documentId, workId: WORK_ID });
}

function preparedPush(documentId: DocumentId, liveDoc: Y.Doc, pushId: number): PreparedPushCommit {
  const pushUpdate = Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(liveDoc));
  const trail = {
    documentId,
    documentTitle: `Document ${pushId}`,
    receiptId: "00000000-0000-4000-8000-000000000011",
    threadIds: [THREAD_ID],
    journalOwners: [{ threadId: THREAD_ID, turnId: TURN_ID }],
    changes: [],
  };
  return {
    branch: branch(documentId, liveDoc),
    journalRows: [],
    pushUpdate,
    idempotencyKey: `push-${pushId}`,
    trail,
    documentTitle: trail.documentTitle,
    lockCutUpdate: Y.encodeStateAsUpdate(liveDoc),
  };
}

function pushRow(prepared: PreparedPushCommit, id: number): PushLineageRow {
  return {
    id,
    branchId: prepared.branch.branchId,
    branchGeneration: prepared.branch.generation,
    documentId: prepared.branch.documentId,
    journalIds: [],
    upstreamUpdateSeq: null,
    idempotencyKey: prepared.idempotencyKey,
  };
}

function coordinator(docs: ReadonlyMap<DocumentId, Y.Doc>) {
  return {
    async withDocument<T>(documentId: DocumentId, run: (doc: Y.Doc) => Promise<T>): Promise<T> {
      const doc = docs.get(documentId);
      if (!doc) throw new Error(`missing ${documentId}`);
      return run(doc);
    },
    async recover() {},
  };
}

/** One staged batch: completion records each document, then returns its projections. */
function stores(
  completed: DocumentId[],
): Pick<Parameters<typeof createBranchPushTransition>[0], "commitStore" | "settlementStore"> {
  let staged: PendingSettlementBatch | null = null;
  const commitStore: PushCommitStore = {
    async commitPushBatch({ settlement, pushes }) {
      const rows = pushes.map((prepared, index) => pushRow(prepared, index + 1));
      staged = {
        batchId: settlement.batchId,
        claim: { token: settlement.claimToken, epoch: 1, kind: "warm", leaseExpiresAt: new Date() },
        attemptCount: 0,
        payloads: new Map(),
        members: pushes.map((prepared, index) => ({
          push: rows[index] as PushLineageRow,
          documentTitle: prepared.documentTitle,
          lockCutUpdate: prepared.lockCutUpdate,
          pushUpdate: prepared.pushUpdate,
          postCutUpdates: [],
          trail: prepared.trail,
          sweepEvidence: null,
          joinVersion: 0,
        })),
      };
      return { status: "inserted", pushes: rows };
    },
    commitDiscard: async () => {},
    lockDraftWorks: async () => new Set<string>(),
  };
  const loaded = async () => {
    if (!staged) throw new Error("no staged batch");
    return staged;
  };
  const settlementStore: PendingSettlementStore = {
    joinAdmission: async () => {},
    loadSettlementBatch: loaded,
    claimRecoverableBatch: async () => null,
    renewClaim: async ({ claim }) => claim,
    recordFailure: async () => true,
    block: async () => true,
    async completeBatch(input) {
      const batch = await loaded();
      expect(
        input.recheck(
          batch.members.map((member) => ({
            pushId: member.push.id,
            documentId: member.push.documentId,
            lockCutUpdate: member.lockCutUpdate,
            postCutUpdates: [],
            pushUpdate: member.pushUpdate,
          })),
        ),
      ).toBe("commit");
      for (const member of batch.members) completed.push(member.push.documentId);
      input.afterCommit(batch.members.map(({ push }) => push.documentId));
      return {
        status: "completed",
        held: [],
        outcomes: [],
        projections: batch.members.map(({ push }) =>
          projection({
            revision: 1,
            documentId: push.documentId,
            changes: [projectedChange(`change-${push.id}`, String(push.id), null, push.documentId)],
          }),
        ),
      };
    },
    checkPublication: async (check) => ({ kind: "proceed", hold: [], payloads: check.payloads }),
    prepareBranchLeases: async () => [],
    loadRecoveryScope: async () => ({ payloads: new Map(), memberBranchIds: [] }),
    listRecoverableBatchIds: async () => [],
  };
  return { commitStore, settlementStore };
}

describe("branch push change-event broadcast", () => {
  it("emits every document of a batch only after the whole batch completes", async () => {
    const alpha = createCollabYDoc({ gc: false });
    const beta = createCollabYDoc({ gc: false });
    const completed: DocumentId[] = [];
    const delivered: DocumentId[] = [];
    const storeDeps = stores(completed);
    const transition = createBranchPushTransition({
      links: createStaticDocumentLinkScopes(),
      ...storeDeps,
      liveCoordinator: coordinator(
        new Map([
          [DOCUMENT_A, alpha],
          [DOCUMENT_B, beta],
        ]),
      ),
      model,
      codec: createAgentEditCodecFactory(mdxCodec({ schema })),
      changeEventDelivery: {
        deliver(message) {
          expect(completed).toEqual([DOCUMENT_A, DOCUMENT_B]);
          delivered.push(message.documentId);
        },
      },
    });

    await transition.execute({
      documentIds: [DOCUMENT_B, DOCUMENT_A],
      prepare: async ({ docs }) => ({
        kind: "push",
        leasedBranchIds: [],
        pushes: [
          preparedPush(DOCUMENT_A, docs.get(DOCUMENT_A) as Y.Doc, 1),
          preparedPush(DOCUMENT_B, docs.get(DOCUMENT_B) as Y.Doc, 2),
        ],
        onConflict: () => "conflict",
        finish: () => "pushed",
      }),
    });

    expect(delivered).toEqual([DOCUMENT_A, DOCUMENT_B]);
    alpha.destroy();
    beta.destroy();
  });
});
