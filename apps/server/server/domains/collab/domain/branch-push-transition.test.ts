/** Settlement ordering over real Yjs documents and in-memory persistence ports. */

import {
  createAgentEditCodec,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, TurnId, WorkId } from "@meridian/contracts/runtime";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import {
  buildDocumentSchema,
  COLLAB_SCHEMA_VERSION,
  createCollabYDoc,
} from "@meridian/prosemirror-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { createInMemoryPendingSettlementStore } from "../test-support/in-memory-pending-settlement-store.js";
import type {
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
} from "./branch-push-contracts.js";
import { createBranchPushTransition, fullStateFingerprint } from "./branch-push-transition.js";
import { NO_DOCUMENT_ASSET_PATHS } from "./ports/document-asset-paths.js";

const documentId = "document" as DocumentId;
const threadId = "thread" as ThreadId;
const turnId = "turn" as TurnId;
const schema = buildDocumentSchema();
const markup = mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver });
const codec = createAgentEditCodec(markup);
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
  const store = createInMemoryPendingSettlementStore({ onCompleted: (id) => completed.push(id) });
  const pushes: PushLineageRow[] = [];
  const commits: PushCommitStore = {
    async commitPush(prepared) {
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
      store.stage({ ...prepared.pendingLiveSettlement, push });
      return { status: "inserted", push, settlement: await store.loadLiveSettlement(push.id) };
    },
    async commitPushBatch() {
      throw new Error("single push fixture");
    },
    async commitDiscard() {
      throw new Error("push only");
    },
    async lockDraftWorks() {
      return new Set<string>();
    },
    async commitTurnRedo() {
      throw new Error("push only");
    },
    async markRollbackPending() {
      throw new Error("push only");
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
      assetPaths: NO_DOCUMENT_ASSET_PATHS,
      commitStore: commits,
      settlementStore: store,
      liveCoordinator: coordinator,
      model,
      codec,
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
    pendingLiveSettlement: owner.prepare({
      documentTitle: "alpha",
      lockCutUpdate: lockCut,
      pushUpdate,
      trail,
      sweepEvidence: null,
    }),
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
          pushes: [prepared],
          afterDurableCommit,
          onConflict: () => "conflict",
          finish: () => "pushed",
        }),
      }),
  };
}

describe("branch push settlement transitions", () => {
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
    "expiry",
    "handoff",
  ] as const)("a live lease denies recovery until %s, then only the replacement completes", async (mode) => {
    vi.useFakeTimers();
    const rig = fixture();
    await expect(
      rig.push(async () => {
        throw new Error("owner stopped");
      }),
    ).rejects.toThrow("owner stopped");
    const pending = await rig.store.loadLiveSettlement(1);
    const replacement = rig.replaceProcess();
    expect(await replacement.recover()).toBe(0);
    if (mode === "handoff")
      expect(await rig.store.handoffClaim({ pushId: 1, claim: pending.claim })).toBe(true);
    else vi.setSystemTime(pending.claim.leaseExpiresAt.getTime() + 1);
    expect(await replacement.recover()).toBe(1);
    expect(await replacement.recover()).toBe(0);
    expect(rig.completed).toEqual([1]);
    expect(rig.text()).toBe("Survivor.");
    expect(await rig.store.renewClaim({ pushId: 1, claim: pending.claim })).toBeNull();
  });

  it.each([
    "before classification",
    "after classification",
  ] as const)("joins delete-only writer changes %s and settles the latest revision", async (when) => {
    const rig = fixture();
    const settle = rig.store.settlePushTrail;
    const revisions: number[] = [];
    rig.store.settlePushTrail = async (input) => {
      revisions.push(input.joinVersion);
      const result = await settle(input);
      if (when === "after classification" && revisions.length === 1) await rig.deletePrefix();
      return result;
    };
    await expect(
      rig.push(when === "before classification" ? rig.deletePrefix : undefined),
    ).resolves.toBe("pushed");
    expect(revisions.at(-1)).toBe(1);
    expect(rig.completed).toEqual([1]);
    expect(rig.text()).toBe("Survivor.");
    expect(await rig.transition().recover()).toBe(0);
  });

  it.each([
    "before apply",
    "after apply",
  ] as const)("recovers %s failure to one terminal completion", async (boundary) => {
    vi.useFakeTimers();
    const rig = fixture();
    const fence = rig.store.withCompletionFence;
    let failed = false;
    rig.store.withCompletionFence = async (input, complete) => {
      if (!failed) {
        failed = true;
        if (boundary === "after apply") expect(complete()).toBe("applied");
        throw new Error("completion fault");
      }
      return fence(input, complete);
    };
    await expect(rig.push()).rejects.toThrow("completion fault");
    expect(rig.completed).toEqual([]);
    const pending = await rig.store.loadLiveSettlement(1);
    vi.setSystemTime(pending.claim.leaseExpiresAt.getTime() + 1);
    expect(await rig.replaceProcess().recover()).toBe(1);
    expect(rig.text()).toBe("Survivor.");
    expect(rig.completed).toEqual([1]);
    expect(await rig.transition().recover()).toBe(0);
  });
});
