/** Unit coverage for collab draft persistence, projection, and lifecycle. */

import { createAgentEditCodec, yProsemirrorModel } from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  DRAFT_STORE_CONTRACT_IDS,
  runDraftStoreContract,
} from "../__conformance__/draft-store-contract.js";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "../adapters/in-memory/agent-edit.js";
import {
  createInMemoryDraftAcceptJournal,
  createInMemoryDraftStore,
} from "../adapters/in-memory/drafts.js";
import {
  createDraftAcceptTurnId,
  createDraftRejectTurnId,
  createDraftService,
  type DraftStore,
} from "./drafts.js";

const DOC_ID = "doc-1" as never;
const THREAD_ID = "thread-1" as never;
const WORK_ID = "work-1" as never;
const USER_ID = "user-1" as never;
const TURN_A = "turn-a" as never;
const TURN_B = "turn-b" as never;

runDraftStoreContract(
  () => {
    const store = createInMemoryDraftStore([
      [DRAFT_STORE_CONTRACT_IDS.threadId as never, DRAFT_STORE_CONTRACT_IDS.workId as never],
      [DRAFT_STORE_CONTRACT_IDS.peerThreadId as never, DRAFT_STORE_CONTRACT_IDS.workId as never],
    ]);
    return {
      store,
      expireAcceptClaim: async (draftId) => store.expireAcceptClaim(draftId),
    };
  },
  {
    skipRecoveryCleanupReason:
      "in-memory draft store has no draft-scoped agent-edit tables to clean",
  },
);

describe("draft lifecycle service", () => {
  it("accepts journal-first as one merged update, applies to live, cleans scoped state, and is idempotent", async () => {
    const scenario = await createScenario();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    const runtime = new Y.Doc({ gc: false });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendText(runtime, "Alpha"),
      actorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendText(runtime, " Beta"),
      actorTurnId: TURN_B,
    });

    const first = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    const second = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });

    expect(first).toMatchObject({
      status: "applied",
      draftId: draft.id,
      acceptTurnId: createDraftAcceptTurnId(draft.id),
    });
    expect(second).toEqual(first);
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(1);
    expect(await liveText(scenario.coordinator)).toBe("Alpha Beta");
    expect(scenario.completeAccept).toHaveBeenCalledWith(
      expect.objectContaining({
        appliedByUserId: USER_ID,
        appliedUpdateSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
      }),
    );
    expect(scenario.journal.mutationRecords(DOC_ID)).toMatchObject([
      {
        writeId: `draft-accept:${draft.id}`,
        turnId: first.status === "applied" ? first.acceptTurnId : undefined,
        createdSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
      },
    ]);
    expect(scenario.journal.updateRecords(DOC_ID)[0]?.meta).toMatchObject({
      origin: "system",
      actorTurnId: TURN_B,
    });
    expect(await scenario.store.getDraft(draft.id)).toMatchObject({
      status: "applied",
      appliedUpdateSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
      appliedByUserId: USER_ID,
    });
  });

  it("returns stale_draft after post-drain rows move past the reviewed token and releases the claim", async () => {
    const scenario = await createScenario();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: updateFromText("Reviewed"),
      actorTurnId: TURN_A,
    });

    const baseListUpdates = scenario.store.listUpdates.bind(scenario.store);
    scenario.store.listUpdates = async (draftId) => {
      const rows = await baseListUpdates(draftId);
      const current = await scenario.store.getDraft(draftId);
      if (current?.status !== "accepting" || !rows[0]) return rows;
      return [
        ...rows,
        {
          ...rows[0],
          id: rows[0].id + 1,
          updateData: updateFromText("Post-drain"),
        },
      ];
    };

    await expect(
      scenario.service.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
        draftRevisionToken: 1,
      }),
    ).resolves.toEqual({
      status: "stale_draft",
      draftId: draft.id,
      draftRevisionToken: 2,
    });

    expect(scenario.completeAccept).not.toHaveBeenCalled();
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(0);
    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "active",
      claimedAt: null,
      claimToken: null,
    });
  });

  it("claims accept before closing and draining the draft room", async () => {
    const events: string[] = [];
    const scenario = await createScenario({
      closeDraftRoom: (draftId) => events.push(`close:${draftId}`),
      drainDraftRoomPersistence: async (draftId) => {
        events.push(`drain:${draftId}`);
      },
    });
    const baseListUpdates = scenario.store.listUpdates.bind(scenario.store);
    scenario.store.listUpdates = async (draftId) => {
      events.push(`list:${draftId}:${(await scenario.store.getDraft(draftId))?.status}`);
      return baseListUpdates(draftId);
    };
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: updateFromText("Applied"),
      actorTurnId: TURN_A,
    });

    await expect(
      scenario.service.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    expect(events.at(-3)).toBe(`close:${draft.id}`);
    expect(events.at(-2)).toBe(`drain:${draft.id}`);
    expect(events.at(-1)).toBe(`list:${draft.id}:accepting`);
  });

  it("rejects without touching live and deletes draft-scoped state", async () => {
    const scenario = await createScenario();
    await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
      doc.getText("body").insert(0, "Live");
    });
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: updateFromText(" Draft"),
      actorTurnId: TURN_A,
    });

    await expect(
      scenario.service.rejectDraft({ documentId: DOC_ID, threadId: THREAD_ID, draftId: draft.id }),
    ).resolves.toEqual({
      status: "discarded",
      draftId: draft.id,
      rejectTurnId: createDraftRejectTurnId(draft.id),
    });

    expect(await liveText(scenario.coordinator)).toBe("Live");
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(0);
    expect(await scenario.store.getDraft(draft.id)).toMatchObject({ status: "discarded" });
    expect(scenario.reject).toHaveBeenCalledWith({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
    });
  });

  it("builds draft docs from current live state plus ordered draft deltas", async () => {
    const scenario = await createScenario();
    await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
      doc.getText("body").insert(0, "Live");
    });
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    const runtime = new Y.Doc({ gc: false });
    await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
      Y.applyUpdate(runtime, Y.encodeStateAsUpdate(doc));
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: appendText(runtime, " Draft"),
      actorTurnId: TURN_A,
    });
    await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
      doc.getText("body").insert(doc.getText("body").length, " Now");
    });

    const projected = await scenario.service.buildDraftDoc({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    expect(projected.getText("body").toString()).toContain("Live");
    expect(projected.getText("body").toString()).toContain("Draft");
    expect(projected.getText("body").toString()).toContain("Now");
  });

  it("auto-discards zero-update drafts on accept", async () => {
    const scenario = await createScenario();
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
    });

    await expect(
      scenario.service.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "discarded", draftId: draft.id });

    expect(await scenario.store.getDraft(draft.id)).toMatchObject({ status: "discarded" });
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(0);
  });

  it("does not resolve stale accept/reject requests to an unrelated active or applied draft", async () => {
    const scenario = await createScenario();
    const appliedDraft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: appliedDraft.id,
      updateData: updateFromText("Applied"),
      actorTurnId: TURN_A,
    });
    await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: appliedDraft.id,
      userId: USER_ID,
    });
    const activeDraft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_B,
    });

    await expect(
      scenario.service.acceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: "stale-draft",
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(
      scenario.service.rejectDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: "stale-draft",
      }),
    ).resolves.toEqual({ status: "not_found" });
    await expect(scenario.store.getDraft(activeDraft.id)).resolves.toMatchObject({
      status: "active",
    });
  });
});

async function createScenario(
  options: {
    closeDraftRoom?: (draftId: string) => void;
    drainDraftRoomPersistence?: (draftId: string) => Promise<void>;
  } = {},
) {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  await lifecycle.ensureDocument(DOC_ID);
  const store = createInMemoryDraftStore([[THREAD_ID, WORK_ID]]);
  const completeAccept = vi.spyOn(store, "completeAccept");
  const reject = vi.spyOn(store, "reject");
  const service = createDraftService({
    draftStore: store,
    liveJournal: createInMemoryDraftAcceptJournal(journal),
    liveUpdateJournal: journal,
    latestLiveUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId),
    liveCoordinator: coordinator,
    model: yProsemirrorModel(buildDocumentSchema()),
    codec: createAgentEditCodec(mdxCodec({ schema: buildDocumentSchema() })),
    closeDraftRoom: options.closeDraftRoom,
    drainDraftRoomPersistence: options.drainDraftRoomPersistence,
  });
  return { journal, coordinator, store: store as DraftStore, service, completeAccept, reject };
}

function updateFromText(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  return appendText(doc, value);
}

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

async function liveText(coordinator: {
  withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
}) {
  return coordinator.withDocument(DOC_ID, async (doc) => doc.getText("body").toString());
}
