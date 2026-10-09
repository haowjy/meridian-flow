/** Focused contract coverage for post-completion branch-push broadcasts. */

import { createAgentEditCodecFactory, yProsemirrorModel } from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createStaticDocumentLinkScopes } from "../adapters/in-memory/static-document-link-scopes.js";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
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

function branch(documentId: DocumentId, doc: Y.Doc): BranchSnapshot {
  return {
    branchId: `branch-${documentId}`,
    documentId,
    kind: "work_draft",
    upstreamBranchId: null,
    workId: WORK_ID,
    threadId: null,
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    schemaVersion: COLLAB_SCHEMA_VERSION,
  };
}

function preparedPush(
  transition: ReturnType<typeof createBranchPushTransition>,
  documentId: DocumentId,
  liveDoc: Y.Doc,
  pushId: number,
): PreparedPushCommit {
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
    pendingLiveSettlement: transition.prepare({
      documentTitle: trail.documentTitle,
      lockCutUpdate: Y.encodeStateAsUpdate(liveDoc),
      pushUpdate,
      trail,
      sweepEvidence: null,
    }),
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

function stores(
  overrides: Partial<PushCommitStore & PendingSettlementStore>,
): Pick<Parameters<typeof createBranchPushTransition>[0], "commitStore" | "settlementStore"> {
  const settlements = new Map<
    number,
    ReturnType<typeof preparedPush>["pendingLiveSettlement"] & { push: PushLineageRow }
  >();
  const commitStore: PushCommitStore = {
    commitPush: async () => {
      throw new Error("unexpected single push");
    },
    commitDiscard: async () => {},
    commitPushBatch: async () => ({ pushes: [] }),
    commitTurnRedo: async () => {},
    lockDraftWorks: async () => new Set<string>(),
    markRollbackPending: async () => 0,
  };
  const settlementStore: PendingSettlementStore = {
    joinAdmission: async () => {},
    loadLiveSettlement: async (pushId) => {
      const pending = settlements.get(pushId);
      if (!pending) throw new Error(`missing settlement ${pushId}`);
      return pending;
    },
    claimRecoverable: async () => null,
    renewClaim: async ({ claim }) => claim,
    handoffClaim: async () => true,
    recordFailure: async () => true,
    block: async () => true,
    settlePushTrail: async () => [],
    withCompletionFence: async (_input, complete) => complete(),
    listRecoverableSettlementIds: async () => [],
  };
  Object.assign(commitStore, overrides);
  Object.assign(settlementStore, overrides);
  const commit = commitStore.commitPush;
  commitStore.commitPush = async (prepared) => {
    const result = await commit(prepared);
    if (result.status === "inserted") {
      settlements.set(result.push.id, { ...prepared.pendingLiveSettlement, push: result.push });
    }
    return result;
  };
  const commitBatch = commitStore.commitPushBatch;
  commitStore.commitPushBatch = async (input) => {
    const result = await commitBatch(input);
    input.pushes.forEach((prepared, index) => {
      const push = result.pushes[index];
      if (push) settlements.set(push.id, { ...prepared.pendingLiveSettlement, push });
    });
    return result;
  };
  return { commitStore, settlementStore };
}

describe("branch push change-event broadcast", () => {
  it("emits each companion document only after that document completes", async () => {
    const alpha = createCollabYDoc({ gc: false });
    const beta = createCollabYDoc({ gc: false });
    const completed: DocumentId[] = [];
    const delivered: DocumentId[] = [];
    const storeDeps = stores({
      async commitPushBatch({ pushes }: { pushes: PreparedPushCommit[] }) {
        const rows = pushes.map((prepared, index) => pushRow(prepared, index + 1));
        return {
          pushes: rows,
          settlements: pushes.map((prepared, index) => ({
            ...prepared.pendingLiveSettlement,
            push: rows[index] as PushLineageRow,
          })),
        };
      },
      async settlePushTrail({ push }: { push: PushLineageRow }) {
        return [
          projection({
            revision: 1,
            documentId: push.documentId,
            changes: [projectedChange(`change-${push.id}`, String(push.id), null, push.documentId)],
          }),
        ];
      },
      async withCompletionFence(
        input: { documentId: DocumentId },
        complete: () => "applied" | "already_applied" | "retry",
      ) {
        const result = complete();
        completed.push(input.documentId);
        return result;
      },
    });
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
          expect(completed).toContain(message.documentId);
          delivered.push(message.documentId);
        },
      },
    });

    await transition.execute({
      documentIds: [DOCUMENT_B, DOCUMENT_A],
      prepare: async ({ docs }) => ({
        kind: "push",
        pushes: [
          preparedPush(transition, DOCUMENT_A, docs.get(DOCUMENT_A) as Y.Doc, 1),
          preparedPush(transition, DOCUMENT_B, docs.get(DOCUMENT_B) as Y.Doc, 2),
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
