/** Unit coverage for collab draft persistence, projection, and lifecycle. */

import {
  createAgentEditCodec,
  fragmentOf,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
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
import { createDraftReviewQueries } from "./draft-review-queries.js";
import { createDraftService, type DraftStore } from "./drafts.js";

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
        writeId: `draft-accept:${draft.id}:1`,
        turnId: null,
        createdSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
      },
    ]);
    expect(scenario.journal.updateRecords(DOC_ID)[0]?.meta).toMatchObject({
      origin: `human:${USER_ID}`,
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

  it.each([
    {
      name: "created document",
      createdDocument: true,
      baseMarkdown: "",
      draftMarkdown: "Chapter born from draft.",
    },
    {
      name: "normal edit",
      createdDocument: false,
      baseMarkdown: "Live chapter seed.",
      draftMarkdown: "Live chapter seed. Draft continuation.",
    },
  ])("reactivates and rebases an accepted $name draft so preview and re-accept work", async ({
    createdDocument,
    baseMarkdown,
    draftMarkdown,
  }) => {
    const reverseToMarkdown = baseMarkdown;
    const scenario = await createScenario({
      reverseAcceptedDraft: async ({ writeId }) => {
        expect(writeId).toBe(`draft-accept:${draft.id}:1`);
        await replaceLiveMarkdown(scenario, reverseToMarkdown);
        return "reversed";
      },
    });
    if (baseMarkdown) await replaceLiveMarkdown(scenario, baseMarkdown);
    const baseLiveUpdateSeq = await scenario.journal.latestUpdateSeq(DOC_ID);
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
      baseLiveUpdateSeq,
    });
    if (createdDocument) {
      await scenario.store.markDraftCreatedDocument({ documentId: DOC_ID, threadId: THREAD_ID });
    }
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: await updateFromMarkdownOverLive(scenario, draftMarkdown),
      actorTurnId: TURN_A,
    });

    const beforePreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(normalizeMarkdown(beforePreview.markdown)).toBe(draftMarkdown);
    expect(reviewChangeCount(beforePreview)).toBeGreaterThan(0);

    const firstAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    expect(firstAccept).toMatchObject({ status: "applied", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(draftMarkdown);

    await expect(
      scenario.service.undoAcceptDraft({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        draftId: draft.id,
        userId: USER_ID,
      }),
    ).resolves.toEqual({ status: "reactivated", draftId: draft.id });
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(baseMarkdown);

    const afterPreview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });
    expect(afterPreview.live).toBe(beforePreview.live);
    expect(normalizeMarkdown(afterPreview.markdown)).toBe(
      normalizeMarkdown(beforePreview.markdown),
    );
    expect(reviewChangeCount(afterPreview)).toBeGreaterThan(0);
    await expect(scenario.store.getDraft(draft.id)).resolves.toMatchObject({
      status: "active",
      baseLiveUpdateSeq: await scenario.journal.latestUpdateSeq(DOC_ID),
      acceptGeneration: 2,
    });

    const updateCountBeforeReaccept = scenario.journal.updateRecords(DOC_ID).length;
    const secondAccept = await scenario.service.acceptDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      draftId: draft.id,
      userId: USER_ID,
    });
    expect(secondAccept).toMatchObject({ status: "applied", draftId: draft.id });
    expect(scenario.journal.updateRecords(DOC_ID)).toHaveLength(updateCountBeforeReaccept + 1);
    expect(scenario.journal.mutationRecords(DOC_ID).map((mutation) => mutation.writeId)).toEqual([
      `draft-accept:${draft.id}:1`,
      `draft-accept:${draft.id}:2`,
    ]);
    expect(normalizeMarkdown(await liveMarkdown(scenario))).toBe(draftMarkdown);
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
    reverseAcceptedDraft?: Parameters<typeof createDraftService>[0]["reverseAcceptedDraft"];
  } = {},
) {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  await lifecycle.ensureDocument(DOC_ID);
  const store = createInMemoryDraftStore([[THREAD_ID, WORK_ID]]);
  const completeAccept = vi.spyOn(store, "completeAccept");
  const reject = vi.spyOn(store, "reject");
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const service = createDraftService({
    draftStore: store,
    liveJournal: createInMemoryDraftAcceptJournal(journal),
    liveUpdateJournal: journal,
    latestLiveUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId),
    liveCoordinator: coordinator,
    model,
    codec,
    closeDraftRoom: options.closeDraftRoom,
    drainDraftRoomPersistence: options.drainDraftRoomPersistence,
    reverseAcceptedDraft: options.reverseAcceptedDraft,
  });
  const preview = createDraftReviewQueries({
    journal,
    draftStore: store,
    liveSeqStore: { latestUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId) },
    codec,
    model,
  });
  return {
    journal,
    coordinator,
    store: store as DraftStore,
    service,
    preview,
    codec,
    model,
    completeAccept,
    reject,
  };
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

async function updateFromMarkdownOverLive(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  markdown: string,
): Promise<Uint8Array> {
  const doc = createCollabYDoc({ gc: false });
  await scenario.coordinator.withDocument(DOC_ID, async (liveDoc) => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(liveDoc));
  });
  const before = Y.encodeStateVector(doc);
  replaceMarkdownInDoc(doc, scenario, markdown);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return update;
}

async function replaceLiveMarkdown(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  markdown: string,
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    replaceMarkdownInDoc(doc, scenario, markdown);
    const update = Y.encodeStateAsUpdate(doc, before);
    await scenario.journal.append(DOC_ID, update, { origin: "system", seq: 0 });
  });
}

function replaceMarkdownInDoc(
  doc: Y.Doc,
  scenario: Pick<Awaited<ReturnType<typeof createScenario>>, "codec" | "model">,
  markdown: string,
): void {
  const parsed = scenario.codec.parse(markdown);
  doc.transact(
    () => {
      const fragment = fragmentOf(doc);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      scenario.model.insertBlocks(toDocHandle(doc), null, parsed);
    },
    { type: "system" },
  );
}

async function liveMarkdown(scenario: Awaited<ReturnType<typeof createScenario>>): Promise<string> {
  return scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    if (scenario.model.getBlocks(toDocHandle(doc)).length === 0) return "";
    return scenario.codec.serialize(scenario.model.projectBlocks(toDocHandle(doc)));
  });
}

function normalizeMarkdown(markdown: string): string {
  return markdown.trimEnd();
}

function reviewChangeCount(review: { operations?: unknown[]; hunks?: unknown[] }): number {
  return (review.operations?.length ?? 0) + (review.hunks?.length ?? 0);
}

async function liveText(coordinator: {
  withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
}) {
  return coordinator.withDocument(DOC_ID, async (doc) => doc.getText("body").toString());
}
