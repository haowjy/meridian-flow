/** Integration coverage for draft accept/reject lifecycle and preview projection. */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  acceptMutationWriteIds,
  appendText,
  createScenario,
  DOC_ID,
  liveText,
  replaceLiveMarkdown,
  THREAD_ID,
  TURN_A,
  TURN_B,
  USER_ID,
  updateFromMarkdownOverLive,
  updateFromText,
} from "./draft-lifecycle-test-helpers.js";

describe("draft accept lifecycle", () => {
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
    expect(scenario.finishClaimedMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        targetStatus: "applied",
        appliedByUserId: USER_ID,
        appliedUpdateSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
      }),
    );
    expect(acceptMutationWriteIds(scenario.journal)).toHaveLength(1);
    expect(scenario.journal.mutationRecords(DOC_ID)[0]).toMatchObject({
      turnId: TURN_B,
      createdSeq: first.status === "applied" ? first.appliedUpdateSeq : undefined,
    });
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

    expect(scenario.finishClaimedMutation).not.toHaveBeenCalled();
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

    const closeIndex = events.indexOf(`close:${draft.id}`);
    const drainIndex = events.indexOf(`drain:${draft.id}`);
    const acceptingListIndex = events.indexOf(`list:${draft.id}:accepting`);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(acceptingListIndex).toBeGreaterThanOrEqual(0);
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

  it("builds review-basis draft projection from journaled live head plus draft rows", async () => {
    const scenario = await createScenario();
    await replaceLiveMarkdown(scenario, "Live");
    const draft = await scenario.store.createActiveDraft({
      documentId: DOC_ID,
      threadId: THREAD_ID,
      lastActorTurnId: TURN_A,
    });
    await scenario.store.appendUpdate({
      draftId: draft.id,
      updateData: await updateFromMarkdownOverLive(scenario, "Live Draft"),
      actorTurnId: TURN_A,
    });
    await replaceLiveMarkdown(scenario, "Live Now");

    const preview = await scenario.preview.previewDraft({
      documentId: DOC_ID,
      draftId: draft.id,
    });

    expect(preview.markdown).toContain("Draft");
    expect(preview.live).toContain("Now");
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
