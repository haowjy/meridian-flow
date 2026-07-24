/** Focused contract coverage for post-completion branch-push broadcasts. */

import { createAgentEditCodec, yProsemirrorModel } from "@meridian/agent-edit";
import type { ChangeEventWsMessage } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId, TurnId, UserId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BranchSnapshot } from "./branch-coordinator.js";
import type {
  BranchPushStore,
  PreparedPushCommit,
  PushLineageRow,
} from "./branch-push-executor.js";
import { createBranchPushTransition } from "./branch-push-transition.js";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";

const DOCUMENT_A = "00000000-0000-4000-8000-000000000001" as DocumentId;
const DOCUMENT_B = "00000000-0000-4000-8000-000000000002" as DocumentId;
const WORK_ID = "00000000-0000-4000-8000-000000000003" as WorkId;
const THREAD_ID = "00000000-0000-4000-8000-000000000004" as ThreadId;
const TURN_ID = "00000000-0000-4000-8000-000000000005" as TurnId;
const USER_W = "00000000-0000-4000-8000-000000000006" as UserId;

const schema = buildDocumentSchema();
const codec = createAgentEditCodec(mdxCodec({ schema }));
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
    beforeBlockId: null,
    afterBlockId: changeId,
    beforeText: null,
    afterTextAtReceipt: `${changeId}|${changeId} body`,
    navigation: { kind: "unavailable", reason: "fixture" },
    swept: null,
    reversible: false,
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
    pushPolicy: "manual",
    status: "active",
    generation: 1,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    schemaVersion: 3,
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
    receiptPayload: {
      version: 1,
      documentId,
      branchId: `branch-${documentId}`,
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [],
      totalWordDelta: 0,
    },
    idempotencyKey: `push-${pushId}`,
    markdownProjection: "",
    liveStateVector: Y.encodeStateVector(liveDoc),
    liveState: Y.encodeStateAsUpdate(liveDoc),
    trail,
    pendingLiveSettlement: transition.prepare({
      documentTitle: trail.documentTitle,
      lockCutUpdate: Y.encodeStateAsUpdate(liveDoc),
      pushUpdate,
      beforeContentRef: null,
      trail,
      provenanceView: [],
      lineageEvidence: { version: 2, items: [] },
      responseEvidence: [],
    }),
  };
}

function pushRow(prepared: PreparedPushCommit, id: number): PushLineageRow {
  return {
    id,
    branchId: prepared.branch.branchId,
    documentId: prepared.branch.documentId,
    pushKind: "whole",
    journalIds: [],
    upstreamUpdateSeq: null,
    receiptPayload: prepared.receiptPayload,
    idempotencyKey: prepared.idempotencyKey,
    pushedByUserId: prepared.pushedByUserId ?? null,
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

function pushStore(overrides: Partial<BranchPushStore>): BranchPushStore {
  return {
    listActiveJournalRows: async () => [],
    listConcurrentJournalRows: async () => [],
    commitPush: async () => {
      throw new Error("unexpected single push");
    },
    countUnpushedRowsForWork: async () => 0,
    listActiveWorkDraftBranchIdsForWork: async () => [],
    updateWorkDraftPushPolicy: async () => {},
    markRollbackPending: async () => 0,
    ...overrides,
  };
}

describe("branch push change-event broadcast", () => {
  it("preserves each push's admitter while deriving turn and shared authors from the shell", async () => {
    const liveDoc = createCollabYDoc({ gc: false });
    const delivered: Array<Omit<ChangeEventWsMessage, "type">> = [];
    const projections = [
      projection({ revision: 1, changes: [projectedChange("auto", "1", null)] }),
      projection({
        revision: 2,
        changes: [
          projectedChange("auto", "1", null),
          {
            ...projectedChange("manual", "2", USER_W),
            kind: "modify",
            beforeText: "manual|writer words remain",
            afterTextAtReceipt: "manual|writer remain",
          },
        ],
      }),
      projection({
        revision: 3,
        owner: { kind: "shared", threadId: THREAD_ID, turnId: null },
        changes: [projectedChange("shared", "3", USER_W)],
      }),
    ];
    let nextPushId = 1;
    const store = pushStore({
      async commitPush(prepared: PreparedPushCommit) {
        const push = pushRow(prepared, nextPushId++);
        return {
          status: "inserted" as const,
          push,
          settlement: { ...prepared.pendingLiveSettlement, push },
        };
      },
      async settlePushTrail() {
        return [projections.shift() as CommittedChangeTrailProjection];
      },
    });
    const transition = createBranchPushTransition({
      pushStore: store,
      liveCoordinator: coordinator(new Map([[DOCUMENT_A, liveDoc]])),
      model,
      codec,
      changeEventDelivery: { deliver: (message) => delivered.push(message) },
    });

    for (let index = 1; index <= 3; index += 1) {
      await transition.execute({
        documentIds: [DOCUMENT_A],
        prepare: async ({ docs }) => ({
          kind: "push",
          pushes: [preparedPush(transition, DOCUMENT_A, docs.get(DOCUMENT_A) as Y.Doc, index)],
          onConflict: () => "conflict",
          finish: () => "pushed",
        }),
      });
    }

    expect(delivered[1]).toMatchObject({
      projectionRevision: 2,
      author: { kind: "agent", threadId: THREAD_ID, turnId: TURN_ID },
      changes: [
        { changeId: "auto", admittedByUserId: null },
        { changeId: "manual", admittedByUserId: USER_W, pureDeletionOffset: 7 },
      ],
    });
    expect(delivered[2]).toMatchObject({
      author: { kind: "agent", threadId: THREAD_ID, turnId: null },
      changes: [{ changeId: "shared", admittedByUserId: USER_W }],
    });
    liveDoc.destroy();
  });

  it("emits only the latest committed projection after a retry succeeds", async () => {
    const liveDoc = createCollabYDoc({ gc: false });
    const delivered: Array<Omit<ChangeEventWsMessage, "type">> = [];
    let fenceAttempt = 0;
    let projectionRevision = 0;
    const store = pushStore({
      async commitPush(prepared: PreparedPushCommit) {
        const push = pushRow(prepared, 1);
        return {
          status: "inserted" as const,
          push,
          settlement: { ...prepared.pendingLiveSettlement, push },
        };
      },
      async settlePushTrail() {
        projectionRevision += 1;
        return [
          projection({
            revision: projectionRevision,
            changes: [projectedChange("latest", "1", null)],
          }),
        ];
      },
      async withCompletionFence(
        _input: unknown,
        complete: () => "applied" | "already_applied" | "retry",
      ) {
        fenceAttempt += 1;
        return fenceAttempt === 1 ? "retry" : complete();
      },
    });
    const transition = createBranchPushTransition({
      pushStore: store,
      liveCoordinator: coordinator(new Map([[DOCUMENT_A, liveDoc]])),
      model,
      codec,
      changeEventDelivery: { deliver: (message) => delivered.push(message) },
    });

    await transition.execute({
      documentIds: [DOCUMENT_A],
      prepare: async ({ docs }) => ({
        kind: "push",
        pushes: [preparedPush(transition, DOCUMENT_A, docs.get(DOCUMENT_A) as Y.Doc, 1)],
        onConflict: () => "conflict",
        finish: () => "pushed",
      }),
    });

    expect(delivered).toEqual([expect.objectContaining({ projectionRevision: 2 })]);
    liveDoc.destroy();
  });

  it("emits for already-applied completion and swallows a delivery failure", async () => {
    const liveDoc = createCollabYDoc({ gc: false });
    const deliver = vi.fn(() => {
      throw new Error("room disappeared");
    });
    const store = pushStore({
      async commitPush(prepared: PreparedPushCommit) {
        const push = pushRow(prepared, 1);
        return {
          status: "inserted" as const,
          push,
          settlement: { ...prepared.pendingLiveSettlement, push },
        };
      },
      async settlePushTrail() {
        return [projection({ revision: 1, changes: [projectedChange("already", "1", null)] })];
      },
      async withCompletionFence() {
        return "already_applied" as const;
      },
    });
    const transition = createBranchPushTransition({
      pushStore: store,
      liveCoordinator: coordinator(new Map([[DOCUMENT_A, liveDoc]])),
      model,
      codec,
      changeEventDelivery: { deliver },
    });

    await expect(
      transition.execute({
        documentIds: [DOCUMENT_A],
        prepare: async ({ docs }) => ({
          kind: "push",
          pushes: [preparedPush(transition, DOCUMENT_A, docs.get(DOCUMENT_A) as Y.Doc, 1)],
          onConflict: () => "conflict",
          finish: () => "pushed",
        }),
      }),
    ).resolves.toBe("pushed");
    expect(deliver).toHaveBeenCalledOnce();
    liveDoc.destroy();
  });

  it("emits each companion document only after that document completes", async () => {
    const alpha = createCollabYDoc({ gc: false });
    const beta = createCollabYDoc({ gc: false });
    const completed: DocumentId[] = [];
    const delivered: DocumentId[] = [];
    const store = pushStore({
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
      pushStore: store,
      liveCoordinator: coordinator(
        new Map([
          [DOCUMENT_A, alpha],
          [DOCUMENT_B, beta],
        ]),
      ),
      model,
      codec,
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
