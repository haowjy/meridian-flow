/**
 * DB cases for the writer's review commands through the route cores: per-change Apply as a
 * content member of one batch, crash recovery, and the command record (resend, conflict, blocked).
 */
import { randomUUID } from "node:crypto";
import { REVIEW_BASE_FRAGMENT, readApplyRecord, readBlocks } from "@meridian/agent-edit/diff";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { branchPushSettlementBatches } from "@meridian/database/schema";
import { allocateDocumentClient, buildDocumentSchema } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { createError } from "nitro/h3";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  handleApplyWorkDraftChangesRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleDraftCommandObservation,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { throwHttpInterrupt } from "../../shared/interrupt-boundary.js";
import { type DraftTreeStart, describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { reviewFrameOfState } from "../../test-support/review-frame.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

/** A live chapter with two independent drafted changes in Ascension's draft. */
async function twoChanges(start: DraftTreeStart) {
  const { runtime, s } = await start();
  const ascension = await s.work("Ascension", "draft");
  const chapter = await s.writer.createDocument("chapter.md", "Opening.\n\nMiddle.\n\nEnd.");
  await s.model(ascension).edit("chapter.md", "Opening.", "Opening, drafted.");
  await s.model(ascension).edit("chapter.md", "End.", "End, drafted.");
  const deps = selectDraftRouteServices(runtime.app);
  const scope = { projectId: s.project.id, workId: ascension.id, userId: s.project.userId };
  const item = async () => {
    const found = (await s.items(ascension)).find((candidate) => candidate.documentId === chapter);
    if (!found) throw new Error("no chapter item");
    return found;
  };
  /** The room the writer reviews: the item's change groups and the snapshot their ids belong to. */
  const frame = async () => {
    const { itemKey, draftId } = await item();
    const { branchId } = await s.draftBranch(ascension, chapter);
    const loaded = await runtime.ports.documentSync.loadHocuspocusBranchState(branchId);
    if (!loaded) throw new Error("the item has no branch state");
    return { draftId, itemKey, ...reviewFrameOfState(loaded.state) };
  };
  /** The `changes` Apply request a click on the first or last change sends from `from` (a frame). */
  const click = async (
    which: "first" | "last",
    from?: Awaited<ReturnType<typeof frame>>,
    commandId = randomUUID(),
  ) => {
    const seen = from ?? (await frame());
    const group = which === "first" ? seen.groups[0] : seen.groups.at(-1);
    if (!group) throw new Error(`no ${which} change`);
    return {
      draftId: seen.draftId,
      itemKey: seen.itemKey,
      commandId,
      changeIds: [group.id],
      snapshot: seen.snapshot,
    };
  };
  const applyChange = (request: Awaited<ReturnType<typeof click>>) =>
    handleApplyWorkDraftChangesRequest(deps, { ...scope, documentId: chapter, request });
  return { runtime, s, ascension, chapter, deps, scope, item, frame, click, applyChange };
}

describeDraftTreeDb("review commands (postgres)", (start, db) => {
  it("1: per-change Apply is one batch per click; the last click leaves the item with nothing to review and the draft active", async () => {
    const c = await twoChanges(start);
    const first = await c.applyChange(await c.click("first"));
    expect(first.body).toMatchObject({ status: "applied", hasChanges: true });
    expect(await c.s.batchStates()).toEqual(["completed"]);
    const live = c.s.view("live");
    expect(await live.text("chapter.md")).toContain("Opening, drafted.");
    expect(await live.text("chapter.md")).not.toContain("End, drafted.");
    const last = await c.applyChange(await c.click("last"));
    expect(last.body).toMatchObject({ status: "applied", hasChanges: false });
    expect(await c.s.batchStates()).toEqual(["completed", "completed"]);
    expect(await c.s.draftStatuses(c.ascension)).toEqual(["active"]);
    expect(await c.s.items(c.ascension)).toEqual([]);
  });

  it.each([
    "edit",
    "rename",
  ] as const)("2: a live %s between selection and staging still applies the chosen change", async (change) => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.beforeStaging", async () => {
      remove();
      if (change === "edit")
        await c.s.writer.write("chapter.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.");
      if (change === "rename") await c.s.writer.move("chapter.md", "chapter-2.md");
    });
    const answer = await c.applyChange(request);
    expect(answer.body).toMatchObject({ status: "applied" });
    const live = c.s.view("live");
    expect(await live.text(change === "rename" ? "chapter-2.md" : "chapter.md")).toContain(
      "Opening, drafted.",
    );
  });

  it("2b: a live delete between selection and staging refuses whole_item with nothing staged", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.beforeStaging", async () => {
      remove();
      await c.s.writer.delete("chapter.md");
    });
    const answer = await c.applyChange(request);
    expect(answer.body).toMatchObject({ status: "whole_item" });
    expect(await c.s.batchStates()).toEqual([]);
  });

  it("3: a live rename after staging merges and the batch completes; a fresh click applies the other change", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const raced = await interleave(
      db,
      () => c.applyChange(request),
      "applyItems.afterStaging",
      () => c.s.writer.move("chapter.md", "chapter-2.md"),
    );
    expect(raced.b.ok).toBe(true);
    expect(raced.a).toMatchObject({ ok: true, value: { body: { status: "applied" } } });
    expect(await c.s.batchStates()).toEqual(["completed"]);
    const live = c.s.view("live");
    expect(await live.text("chapter-2.md")).toContain("Opening, drafted.");
    expect((await c.applyChange(await c.click("last"))).body).toMatchObject({
      status: "applied",
      hasChanges: false,
    });
  });

  it("4: a kill after staging, then a late writer's recovery that consumes client 1's clocks, still recovers exactly the selected change and advances the base", async () => {
    const c = await twoChanges(start);
    const sync = c.runtime.ports.documentSync;
    const { branchId } = await c.s.draftBranch(c.ascension, c.chapter);
    const load = async () => {
      const loaded = await sync.loadHocuspocusBranchState(branchId);
      if (!loaded) throw new Error("the item has no branch state");
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, loaded.state);
      return doc;
    };
    const paragraphs = (doc: Y.Doc, fragment: string) =>
      readBlocks(doc.getXmlFragment(fragment), buildDocumentSchema()).map((b) => b.textContent);
    const client1 = (doc: Y.Doc) => Y.decodeStateVector(Y.encodeStateVector(doc)).get(1) ?? 0;

    // A writer's tab opens the draft, then live rewrites the paragraph they are about to type into.
    const peer = await load();
    await c.s.writer.write("chapter.md", "Opening.\n\nCentre.\n\nEnd.");
    await sync.flushBranchLivePull(c.chapter);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.afterStaging", async () => {
      remove();
      throw new Error("injected process death after staging");
    });
    await expect(c.applyChange(request)).rejects.toThrow("process death");
    expect(await c.s.batchStates()).toEqual(["pending"]);

    // The batch is pending without its leases: the late update is admitted and recovered as client 1.
    const room = await load();
    const clockBefore = client1(room);
    const before = Y.encodeStateVector(peer);
    peer.clientID = allocateDocumentClient(peer);
    const typed = (peer.getXmlFragment("prosemirror").get(1) as Y.XmlElement).get(0) as Y.XmlText;
    typed.insert(0, "quickly ");
    const update = Y.encodeStateAsUpdate(peer, before);
    Y.applyUpdate(room, update);
    await sync.admitBranchWriterUpdate({
      branchId,
      update,
      origin: { type: "user", userId: c.scope.userId },
      document: room,
    });
    const admitted = await load();
    expect(client1(admitted)).toBeGreaterThan(clockBefore);
    expect(await c.s.batchStates()).toEqual(["pending"]);

    await c.s.expirePendingClaims();
    expect(await c.s.recover()).toBe(1);
    expect(await c.s.batchStates()).toEqual(["completed"]);
    const settled = await load();
    const snapshot = {
      live: await c.s.view("live").text("chapter.md"),
      draft: paragraphs(settled, "prosemirror"),
      base: paragraphs(settled, REVIEW_BASE_FRAGMENT),
      remaining: (await c.frame()).groups.length,
    };
    expect(snapshot).toEqual({
      live: "Opening, drafted.\n\nCentre.\n\nEnd.\n",
      draft: ["Opening, drafted.", "Centre.", "quickly", "End, drafted."],
      base: ["Opening, drafted.", "Centre.", "End."],
      remaining: 1,
    });
    // The recovered Apply moved the base and wrote its record in the same state write.
    expect(readApplyRecord(settled)).toHaveLength(1);
    expect(await c.s.recover()).toBe(0);
    expect(await c.s.view("live").text("chapter.md")).toBe(snapshot.live);
    expect(paragraphs(await load(), REVIEW_BASE_FRAGMENT)).toEqual(snapshot.base);
  });

  it("11: a command id sent twice, after completion and concurrently, has one effect and one answer", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const first = await c.applyChange(request);
    expect(first.body).toMatchObject({ status: "applied" });
    expect(await c.applyChange(request)).toEqual(first);
    expect(await c.s.batchStates()).toEqual(["completed"]);

    const concurrent = await c.click("last");
    const [a, b] = await Promise.all([c.applyChange(concurrent), c.applyChange(concurrent)]);
    expect(a.body).toMatchObject({ status: "applied", hasChanges: false });
    expect(b).toEqual(a);
    expect(await c.s.batchStates()).toEqual(["completed", "completed"]);
  });

  it("11: an id reused for a different body, kind or Work answers 409 command_conflict", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    await c.applyChange(request);
    const different = { ...request, changeIds: [...request.changeIds, "other"] };
    await expect(c.applyChange(different)).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      handleApplyWorkDraftRequest(c.deps, {
        ...c.scope,
        documentId: c.chapter,
        request: {
          draftId: request.draftId,
          itemKey: request.itemKey,
          commandId: request.commandId,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("12: a resend after the first command changed what validation sees returns the stored success", async () => {
    const c = await twoChanges(start);
    // A per-change Apply that leaves the item with nothing to review: its resend finds no item.
    const one = await c.click("first");
    await c.applyChange(one);
    const last = await c.click("last");
    const drained = await c.applyChange(last);
    expect(drained.body).toMatchObject({ status: "applied", hasChanges: false });
    expect(await c.applyChange(last)).toEqual(drained);

    // Discard all closes the draft: its resend finds no draft.
    await c.s.model(c.ascension).edit("chapter.md", "Middle.", "Middle, drafted.");
    const draftId = (await c.s.items(c.ascension))[0]?.draftId as string;
    const request = { draftId, commandId: randomUUID() };
    const closed = await handleDiscardAllWorkDraftRequest(c.deps, { ...c.scope, request });
    expect(closed.body).toMatchObject({ status: "discarded" });
    expect(await handleDiscardAllWorkDraftRequest(c.deps, { ...c.scope, request })).toEqual(closed);

    // A refused item Discard is recorded too: once a model write recreates the item, its
    // resend still answers the stored gone and closes nothing (§1.4).
    await c.s.model(c.ascension).edit("chapter.md", "Middle.", "Middle, again.");
    const next = await c.item();
    const discard = (body: { draftId: string; itemKey: string; commandId: string }) =>
      handleDiscardWorkDraftRequest(c.deps, { ...c.scope, documentId: c.chapter, request: body });
    await discard({ draftId: next.draftId, itemKey: next.itemKey, commandId: randomUUID() });
    const gone = { draftId: next.draftId, itemKey: next.itemKey, commandId: randomUUID() };
    const refused = await discard(gone);
    expect(refused.body).toEqual({ status: "gone", draftId: next.draftId, itemKey: next.itemKey });
    await c.s.model(c.ascension).edit("chapter.md", "Middle.", "Middle, thrice.");
    expect(await c.s.items(c.ascension)).toHaveLength(1);
    expect(await discard(gone)).toEqual(refused);
    expect(await c.s.items(c.ascension)).toHaveLength(1);
  });

  it.each([
    {
      name: "not found",
      refuse: () => createError({ statusCode: 404, message: "Draft not found" }),
    },
    {
      name: "archived",
      refuse: () => {
        try {
          throwHttpInterrupt(
            meridianErrorFromSystem("work_archived", "This Work is archived and read-only."),
            403,
          );
        } catch (refusal) {
          return refusal;
        }
      },
    },
  ])("12b: a twin that lost the race to its own command's effect answers the stored outcome when its grant is refused ($name)", async ({
    refuse,
  }) => {
    const c = await twoChanges(start);
    const { itemKey, draftId } = await c.item();
    const request = {
      draftId,
      itemKey,
      commandId: randomUUID(),
    } as Parameters<typeof handleDiscardWorkDraftRequest>[1]["request"];
    let twin: Awaited<ReturnType<typeof handleDiscardWorkDraftRequest>> | undefined;
    const authorize = c.deps.fileAccess.authorize.bind(c.deps.fileAccess);
    let first = true;
    const deps = {
      ...c.deps,
      fileAccess: {
        ...c.deps.fileAccess,
        // The twin's grant arrives after the first request has committed and tombstoned.
        authorize: async (...args: Parameters<typeof authorize>) => {
          if (first) {
            first = false;
            twin = await handleDiscardWorkDraftRequest(c.deps, {
              ...c.scope,
              documentId: c.chapter,
              request,
            });
            throw refuse();
          }
          return authorize(...args);
        },
      },
    } as typeof c.deps;
    const answered = await handleDiscardWorkDraftRequest(deps, {
      ...c.scope,
      documentId: c.chapter,
      request,
    });
    expect(twin?.body).toMatchObject({ status: "discarded" });
    expect(answered).toEqual(twin);
  });

  it("13: a blocked batch is observed as blocked, and a resend stages nothing", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.afterStaging", async () => {
      remove();
      throw new Error("injected process death after staging");
    });
    await expect(c.applyChange(request)).rejects.toThrow("process death");
    await db
      .update(branchPushSettlementBatches)
      .set({
        state: "blocked",
        blockedAt: new Date(),
        lastErrorCode: "test_block",
        claimToken: null,
        claimKind: null,
        claimedAt: null,
        leaseExpiresAt: null,
      })
      .where(eq(branchPushSettlementBatches.state, "pending"));
    expect(
      await handleDraftCommandObservation(c.deps, { ...c.scope, commandId: request.commandId }),
    ).toEqual({ state: "blocked" });
    expect((await c.applyChange(request)).httpStatus).toBe(202);
    expect(await c.s.batchStates()).toEqual(["blocked"]);
  });

  it("5: a live edit to the chosen change's own words is overrode, and the draft's words win", async () => {
    const c = await twoChanges(start);
    await c.s.model(c.ascension).edit("chapter.md", "End, drafted.", "Finale, drafted.");
    const request = await c.click("last");
    const remove = setCollabHook("applyItems.beforeStaging", async () => {
      remove();
      await c.s.writer.write("chapter.md", "Opening.\n\nMiddle.\n\nEnding.");
    });
    const answer = await c.applyChange(request);
    expect(answer.body).toMatchObject({
      status: "applied",
      hasChanges: true,
      overrode: [
        { live: expect.stringContaining("Ending"), applied: expect.stringContaining("Finale") },
      ],
    });
    expect(await c.s.view("live").text("chapter.md")).toContain("Finale, drafted.");
  });

  it("6: a change live reads between catch-up and the lock cut is already_live, writes nothing live, and leaves review", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.afterCatchUp", async () => {
      remove();
      await c.s.writer.write("chapter.md", "Opening, drafted.\n\nMiddle.\n\nEnd.");
    });
    const answer = await c.applyChange(request);
    expect(answer.body).toMatchObject({ status: "already_live", hasChanges: true });
    expect(await c.s.batchStates()).toEqual(["completed"]);
    expect(await c.s.view("live").text("chapter.md")).not.toContain("End, drafted.");
    // Live reading the draft's words must also consume the change: only the other remains.
    expect((await c.frame()).groups).toHaveLength(1);
  });

  it("7: a planning exception is failed merge_failed: no content or tree effect commits, the item stays reviewable", async () => {
    const c = await twoChanges(start);
    const request = await c.click("first");
    const remove = setCollabHook("applyItems.planning", async () => {
      remove();
      throw new Error("injected planning exception");
    });
    const answer = await c.applyChange(request);
    expect(answer.body).toMatchObject({ status: "failed", reason: "merge_failed" });
    expect(await c.s.view("live").text("chapter.md")).not.toContain("drafted");
    expect((await c.s.items(c.ascension)).length).toBe(1);
  });

  it("8: a snapshotless Apply recovered after the draft grew applies the staging-time text", async () => {
    const c = await twoChanges(start);
    const remove = setCollabHook("applyItems.afterStaging", async () => {
      remove();
      throw new Error("injected process death after staging");
    });
    await expect(c.s.applyAll(c.ascension)).rejects.toThrow("process death");
    await c.s.model(c.ascension).edit("chapter.md", "Middle.", "Middle, later.");
    await c.s.expirePendingClaims();
    await c.s.recover();
    const text = await c.s.view("live").text("chapter.md");
    expect(text).toContain("Opening, drafted.");
    expect(text).toContain("End, drafted.");
    expect(text).not.toContain("Middle, later.");
    expect((await c.s.items(c.ascension)).length).toBe(1);
  });
});
