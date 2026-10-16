/** Consolidated test contracts; each block retains its original fixture scope. */

import {
  createAgentEditCodecFactory,
  type DocumentCoordinator,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { describe as __mergedSuite, afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
/** Regression coverage for branch-push behavior preserved by the candidate pipeline. */
/** Settlement ordering over real Yjs documents and in-memory persistence ports. */
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { createInMemoryJournal } from "../adapters/in-memory/agent-edit.js";
import { createStaticDocumentLinkScopes } from "../adapters/in-memory/static-document-link-scopes.js";
import {
  createInMemoryPendingSettlementStore,
  type InMemoryPendingSettlementStore,
} from "../test-support/in-memory-pending-settlement-store.js";
import { unimplementedBranchMutations } from "../test-support/unimplemented-branch-mutations.js";
import type { BranchSnapshot, BranchStore } from "./branch-coordinator.js";
import {
  type BranchCriticalSections,
  createBranchCriticalSections,
} from "./branch-critical-sections.js";
import { createBranchPushService } from "./branch-push.js";
import type {
  BranchJournalReadStore,
  BranchJournalRow,
  PendingSettlementBatch,
  PreparedDiscardCommit,
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
  SettlementBatchIdentity,
} from "./branch-push-contracts.js";
import { createBranchPushTransition, fullStateFingerprint } from "./branch-push-transition.js";
import type { CommittedChangeTrailProjection } from "./ports/change-trail-persistence.js";
import type { DocumentLinkScopes, LinkScopeKey } from "./ports/document-link-scope.js";
import type { PendingSettlementStore } from "./ports/pending-settlement-store.js";

__mergedSuite("branch-push-broadcast.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/branch-push-broadcast.test.ts.
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
      draftId: "draft-1",
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
          claim: {
            token: settlement.claimToken,
            epoch: 1,
            kind: "warm",
            leaseExpiresAt: new Date(),
          },
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
              changes: [
                projectedChange(`change-${push.id}`, String(push.id), null, push.documentId),
              ],
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

  __mergedSuite("branch push change-event broadcast", () => {
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
});

__mergedSuite("branch-push-review-regressions.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/branch-push-review-regressions.test.ts.
  const CONTENT_ID = "00000000-0000-4000-8000-000000000101" as DocumentId;

  const WORK_ID = "00000000-0000-4000-8000-000000000103" as WorkId;

  const THREAD_ID = "00000000-0000-4000-8000-000000000104" as ThreadId;

  const TURN_ID = "00000000-0000-4000-8000-000000000105" as TurnId;

  const schema = buildDocumentSchema();

  const codec = mdxCodec({ schema });

  const model = yProsemirrorModel(schema);

  function docFromMarkdown(markdown: string): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    model.insertBlocks(toDocHandle(doc), null, codec.parse(markdown));
    return doc;
  }

  function cloneDoc(source: Y.Doc): Y.Doc {
    const doc = createCollabYDoc({ gc: false });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
    return doc;
  }

  function branchFromDoc(branchId: string, documentId: DocumentId, doc: Y.Doc): BranchSnapshot {
    return {
      branchId,
      documentId,
      kind: "work_draft",
      upstreamBranchId: null,
      draftId: "draft-1",
      workId: WORK_ID,
      threadId: null,
      status: "active",
      generation: 1,
      state: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      schemaVersion: COLLAB_SCHEMA_VERSION,
    };
  }

  function rowFor(
    branch: BranchSnapshot,
    id: number,
    updateData: Uint8Array,
    updateMeta?: unknown,
  ): BranchJournalRow {
    return {
      id,
      branchId: branch.branchId,
      generation: branch.generation,
      wId: id,
      source: "agent",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      actorUserId: null,
      updateData,
      draftBaseUpdateSeq: 1,
      status: "active",
      ...(updateMeta === undefined ? {} : { updateMeta }),
    };
  }

  class StateBackedPushStores implements BranchJournalReadStore, PushCommitStore {
    readonly pushes: PushLineageRow[];
    constructor(
      readonly rows: BranchJournalRow[],
      pushes: readonly PushLineageRow[],
      private readonly journal: ReturnType<typeof createInMemoryJournal>,
      private readonly settlements: InMemoryPendingSettlementStore,
    ) {
      this.pushes = [...pushes];
    }
    async listActiveJournalRows(branchId: string, generation: number) {
      return this.rows.filter(
        (row) =>
          row.branchId === branchId && row.generation === generation && row.status === "active",
      );
    }
    async listReviewableJournalRows(branchId: string, generation: number) {
      return this.rows.filter(
        (row) =>
          row.branchId === branchId &&
          row.generation === generation &&
          (row.status === "active" || row.status === "rollback_pending"),
      );
    }
    async listConcurrentJournalRows(
      branchId: string,
      generation: number,
      options: {
        afterJournalId?: number;
        documentId: DocumentId;
      },
    ) {
      return this.rows.filter(
        (row) =>
          row.branchId !== branchId &&
          row.generation <= generation &&
          row.status === "pushed" &&
          row.id > (options.afterJournalId ?? 0) &&
          this.pushes.some(
            (push) => push.branchId === row.branchId && push.documentId === options.documentId,
          ),
      );
    }
    async latestPushForBranch(branchId: string, generation: number) {
      return (
        [...this.pushes]
          .reverse()
          .find((push) => push.branchId === branchId && push.branchGeneration === generation) ??
        null
      );
    }
    async listJournalRowsForTurn(input: {
      branchId?: string;
      generation?: number;
      threadId: ThreadId;
      turnId: TurnId;
      statuses?: readonly BranchJournalRow["status"][];
    }) {
      return this.rows.filter(
        (row) =>
          row.threadId === input.threadId &&
          row.turnId === input.turnId &&
          (input.branchId === undefined || row.branchId === input.branchId) &&
          (input.generation === undefined || row.generation === input.generation) &&
          (!input.statuses || input.statuses.includes(row.status)),
      );
    }
    async listJournalRowsForBranch(input: {
      branchId: string;
      generation: number;
      throughJournalId?: number;
    }) {
      return this.rows.filter(
        (row) =>
          row.branchId === input.branchId &&
          row.generation === input.generation &&
          (input.throughJournalId === undefined || row.id <= input.throughJournalId),
      );
    }
    async listPushLineageForTurn(input: { threadId: ThreadId; turnId: TurnId }) {
      return this.pushes.filter(
        (push) => push.threadId === input.threadId && push.turnId === input.turnId,
      );
    }
    async commitPushBatch(input: {
      settlement: SettlementBatchIdentity;
      pushes: readonly PreparedPushCommit[];
    }) {
      for (const prepared of input.pushes) {
        const existing = this.pushes.find(
          (push) => push.idempotencyKey === prepared.idempotencyKey,
        );
        if (existing) return { status: "conflict" as const, push: existing };
      }
      const pushes: PushLineageRow[] = [];
      for (const prepared of input.pushes) pushes.push(await this.insertPush(prepared));
      this.settlements.stage({
        batchId: input.settlement.batchId,
        claimToken: input.settlement.claimToken,
        members: input.pushes.map((prepared, index) => ({
          push: pushes[index] as PushLineageRow,
          documentTitle: prepared.documentTitle,
          lockCutUpdate: prepared.lockCutUpdate,
          pushUpdate: prepared.pushUpdate,
          trail: prepared.trail,
          sweepEvidence: null,
        })),
      });
      return { status: "inserted" as const, pushes };
    }
    async commitDiscard(_input: PreparedDiscardCommit): Promise<void> {
      throw new Error("review regression store does not support discard");
    }
    async lockDraftWorks(): Promise<ReadonlySet<string>> {
      return new Set();
    }
    async commitTurnRedo(_input: PreparedDiscardCommit): Promise<void> {
      throw new Error("review regression store does not support redo");
    }
    async markRollbackPending(): Promise<number> {
      throw new Error("review regression store does not support rollback marking");
    }
    private async insertPush(input: PreparedPushCommit): Promise<PushLineageRow> {
      const upstreamUpdateSeq = await this.journal.append(
        input.branch.documentId,
        input.pushUpdate,
        {
          origin: `push:${input.branch.branchId}`,
          seq: 0,
        },
      );
      for (const candidate of input.journalRows) candidate.status = "pushed";
      const push: PushLineageRow = {
        id: this.pushes.length + 1,
        branchId: input.branch.branchId,
        branchGeneration: input.branch.generation,
        documentId: input.branch.documentId,
        journalIds: input.journalRows.map((row) => row.id),
        upstreamUpdateSeq,
        idempotencyKey: input.idempotencyKey,
        receiptId: input.receiptId,
        threadId: input.journalRows[0]?.threadId ?? null,
        turnId: input.journalRows[0]?.turnId ?? null,
      };
      this.pushes.push(push);
      return push;
    }
  }

  function serviceFixture(input: {
    links?: DocumentLinkScopes;
    criticalSections?: BranchCriticalSections;
    branches: readonly BranchSnapshot[];
    rows: BranchJournalRow[];
    pushes?: readonly PushLineageRow[];
    journal: ReturnType<typeof createInMemoryJournal>;
    liveDocs: ReadonlyMap<DocumentId, Y.Doc>;
  }) {
    const settlements = createInMemoryPendingSettlementStore();
    const stores = new StateBackedPushStores(
      input.rows,
      input.pushes ?? [],
      input.journal,
      settlements,
    );
    const branches = new Map(input.branches.map((branch) => [branch.branchId, branch]));
    const branchStore: BranchStore = {
      ...unimplementedBranchMutations(),
      deferUntilCommit(callback) {
        callback();
        return true;
      },
      async getBranch(branchId) {
        return branches.get(branchId) ?? null;
      },
      async updateBranchSnapshot() {
        return true;
      },
    };
    const liveCoordinator: DocumentCoordinator = {
      async withDocument(documentId, run) {
        const doc = input.liveDocs.get(documentId as DocumentId);
        if (!doc) throw new Error(`Missing live document ${documentId}`);
        return run(doc);
      },
      async recover() {},
    };
    return {
      stores,
      service: createBranchPushService({
        links: input.links ?? createStaticDocumentLinkScopes(),
        criticalSections: input.criticalSections,
        changeEventDelivery: { deliver() {} },
        branchStore,
        journalReadStore: stores,
        commitStore: stores,
        settlementStore: settlements,
        journal: input.journal,
        liveCoordinator,
        model,
        codec: createAgentEditCodecFactory(codec),
      }),
    };
  }

  async function blindConflictFixture(
    options: { links?: DocumentLinkScopes; criticalSections?: BranchCriticalSections } = {},
  ) {
    const contentLive = docFromMarkdown("Doomed paragraph.\n\nSurvivor paragraph.");
    const contentBranchDoc = cloneDoc(contentLive);
    const doomed = model.getBlocks(toDocHandle(contentBranchDoc))[0];
    if (!doomed) throw new Error("Missing branch block");
    const beforeDelete = Y.encodeStateVector(contentBranchDoc);
    model.deleteBlock(toDocHandle(contentBranchDoc), doomed);
    const contentBranch = branchFromDoc("branch_content", CONTENT_ID, contentBranchDoc);
    const row = rowFor(contentBranch, 1, Y.encodeStateAsUpdate(contentBranchDoc, beforeDelete));
    const journal = createInMemoryJournal();
    await journal.append(CONTENT_ID, Y.encodeStateAsUpdate(contentLive), {
      origin: "system",
      seq: 0,
    });
    const liveDoomed = model.getBlocks(toDocHandle(contentLive))[0];
    if (!liveDoomed) throw new Error("Missing live block");
    const beforeWriter = Y.encodeStateVector(contentLive);
    model.applyTextEdit(
      toDocHandle(contentLive),
      liveDoomed,
      { from: 0, to: model.getText(liveDoomed).length },
      "Writer changed this after the draft.",
    );
    await journal.append(CONTENT_ID, Y.encodeStateAsUpdate(contentLive, beforeWriter), {
      origin: "human:writer",
      seq: 0,
    });
    Y.applyUpdate(contentBranchDoc, Y.encodeStateAsUpdate(contentLive));
    contentBranch.state = Y.encodeStateAsUpdate(contentBranchDoc);
    contentBranch.stateVector = Y.encodeStateVector(contentBranchDoc);
    const fixture = serviceFixture({
      ...options,
      branches: [contentBranch],
      rows: [row],
      journal,
      liveDocs: new Map([[CONTENT_ID, contentLive]]),
    });
    return { ...fixture, contentBranch };
  }

  __mergedSuite("branch push review regressions", () => {
    it("opens the link scope before branch locks", async () => {
      const criticalSections = createBranchCriticalSections();
      let loaded = false;
      const fixture = await blindConflictFixture({
        criticalSections,
        links: {
          ...createStaticDocumentLinkScopes(),
          async within<T>(_key: LinkScopeKey, operation: () => Promise<T>) {
            // Nested settlement reuses the operation's snapshot, just as the adapter does.
            if (!loaded) {
              await criticalSections.withBranches(["branch_content"], async () => {
                loaded = true;
              });
            }
            return operation();
          },
        },
      });
      const result = await fixture.service.pushToLive({ branchId: fixture.contentBranch.branchId });
      expect(result.status).toBe("pushed");
      expect(loaded).toBe(true);
    });
    it("always applies writer-overlapping whole pushes", async () => {
      const whole = await blindConflictFixture();
      await expect(
        whole.service.pushToLive({
          branchId: whole.contentBranch.branchId,
        }),
      ).resolves.toMatchObject({ status: "pushed" });
    });
  });
});

__mergedSuite("branch-push-transition.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/branch-push-transition.test.ts.
  const documentId = "document" as DocumentId;

  const threadId = "thread" as ThreadId;

  const turnId = "turn" as TurnId;

  const schema = buildDocumentSchema();

  const markup = mdxCodec({ schema });

  const model = yProsemirrorModel(schema);

  const docs: Y.Doc[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const doc of docs.splice(0)) doc.destroy();
  });

  function document(update?: Uint8Array) {
    const doc = createCollabYDoc({ gc: false });
    docs.push(doc);
    if (update) Y.applyUpdate(doc, update);
    return doc;
  }

  function fixture() {
    let live = document();
    model.insertBlocks(
      toDocHandle(live),
      null,
      markup.parse("Writer recent: Writer captured body.\n\nSurvivor."),
    );
    const lockCut = Y.encodeStateAsUpdate(live);
    const branch = document(lockCut);
    const doomed = model.getBlocks(toDocHandle(branch))[0]!;
    const before = Y.encodeStateVector(branch);
    model.deleteBlock(toDocHandle(branch), doomed);
    const pushUpdate = Y.encodeStateAsUpdate(branch, before);
    const completed: number[] = [];
    const store = createInMemoryPendingSettlementStore({
      onCompleted: (id) => completed.push(id),
    });
    const pushes: PushLineageRow[] = [];
    const commits: PushCommitStore = {
      async commitPushBatch({ settlement, pushes: [prepared] }) {
        if (!prepared) throw new Error("single push fixture");
        const push = {
          id: 1,
          branchId: "branch",
          branchGeneration: 1,
          documentId,
          journalIds: [],
          upstreamUpdateSeq: 1,
          idempotencyKey: "push",
        };
        pushes.push(push);
        store.stage({
          batchId: settlement.batchId,
          claimToken: settlement.claimToken,
          members: [
            {
              push,
              documentTitle: prepared.documentTitle,
              lockCutUpdate: prepared.lockCutUpdate,
              pushUpdate: prepared.pushUpdate,
              trail: prepared.trail,
              sweepEvidence: null,
            },
          ],
        });
        return { status: "inserted", pushes: [push] };
      },
      async commitDiscard() {
        throw new Error("push only");
      },
      async lockDraftWorks() {
        return new Set<string>();
      },
    };
    const mutex = new KeyedMutex();
    const coordinator = {
      withDocument<T>(_id: string, run: (doc: Y.Doc) => Promise<T>) {
        return mutex.run(documentId, () => run(live));
      },
      async recover() {},
    };
    const transition = () =>
      createBranchPushTransition({
        links: createStaticDocumentLinkScopes(),
        commitStore: commits,
        settlementStore: store,
        liveCoordinator: coordinator,
        model,
        codec: createAgentEditCodecFactory(markup),
        changeEventDelivery: { deliver() {} },
      });
    const owner = transition();
    const trail = {
      documentId,
      documentTitle: "alpha",
      receiptId: "receipt",
      threadIds: [threadId],
      journalOwners: [{ threadId, turnId }],
      changes: [],
    };
    const prepared: PreparedPushCommit = {
      branch: {
        branchId: "branch",
        documentId,
        kind: "work_draft",
        upstreamBranchId: null,
        draftId: "draft-1",
        workId: "work" as WorkId,
        threadId: null,
        status: "active",
        generation: 1,
        state: Y.encodeStateAsUpdate(branch),
        stateVector: Y.encodeStateVector(branch),
        schemaVersion: COLLAB_SCHEMA_VERSION,
      },
      journalRows: [],
      pushUpdate,
      idempotencyKey: "push",
      trail,
      documentTitle: "alpha",
      lockCutUpdate: lockCut,
    };
    let admission = 0;
    async function deletePrefix() {
      const block = model.getBlocks(toDocHandle(live))[0]!;
      const vector = Y.encodeStateVector(live);
      const fingerprint = fullStateFingerprint(live);
      model.applyTextEdit(toDocHandle(live), block, { from: 0, to: "Writer recent: ".length }, "");
      expect(Y.encodeStateVector(live)).toEqual(vector);
      expect(fullStateFingerprint(live)).not.toBe(fingerprint);
      await store.joinAdmission({
        documentId,
        update: Y.encodeStateAsUpdate(live, vector),
        source: { kind: "journal", id: String(++admission) },
      });
    }
    return {
      store,
      pushes,
      completed,
      coordinator,
      transition,
      deletePrefix,
      text: () =>
        model
          .getBlocks(toDocHandle(live))
          .map((block) => model.getText(block))
          .join("\n"),
      replaceProcess: () => {
        const update = Y.encodeStateAsUpdate(live);
        live.destroy();
        live = document(update);
        return transition();
      },
      push: (afterDurableCommit?: () => Promise<void>) =>
        owner.execute({
          documentIds: [documentId],
          prepare: async () => ({
            kind: "push",
            leasedBranchIds: [],
            pushes: [prepared],
            afterDurableCommit,
            onConflict: () => "conflict",
            finish: () => "pushed",
          }),
        }),
    };
  }

  __mergedSuite("branch push settlement transitions", () => {
    it("does not admit a queued writer through an awaited preparation failure", async () => {
      const rig = fixture();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const push = rig.transition().execute({
        documentIds: [documentId],
        prepare: async () => {
          entered();
          await gate;
          throw new Error("preparation failed");
        },
      });
      await ready;
      let crossed = false;
      const writer = rig.coordinator.withDocument(documentId, async () => {
        crossed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(crossed).toBe(false);
      expect(rig.pushes).toEqual([]);
      release();
      await expect(push).rejects.toThrow("preparation failed");
      await writer;
      expect(crossed).toBe(true);
      expect(rig.pushes).toEqual([]);
      expect(rig.completed).toEqual([]);
    });
    it.each([
      "before classification",
      "after classification",
    ] as const)("joins delete-only writer changes %s and settles the latest revision", async (when) => {
      const rig = fixture();
      const complete = rig.store.completeBatch;
      const revisions: number[] = [];
      rig.store.completeBatch = async (input) => {
        revisions.push(input.members[0]?.joinVersion ?? -1);
        if (when === "after classification" && revisions.length === 1) await rig.deletePrefix();
        return complete(input);
      };
      await expect(
        rig.push(when === "before classification" ? rig.deletePrefix : undefined),
      ).resolves.toBe("pushed");
      expect(revisions.at(-1)).toBe(1);
      expect(rig.completed).toEqual([1]);
      expect(rig.text()).toBe("Survivor.");
      expect(await rig.transition().recover()).toBe(0);
    });
  });
});
