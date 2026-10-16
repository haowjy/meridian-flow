/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import type { DocumentId } from "@meridian/contracts";
import { meridianErrorFromSystem } from "@meridian/contracts/protocol";
import { branchPushSettlementBatches } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { createError } from "nitro/h3";
import { describe as __mergedSuite, expect, it } from "vitest";
import * as Y from "yjs";
import {
  handleApplyWorkDraftChangesRequest,
  handleApplyWorkDraftRequest,
  handleDiscardAllWorkDraftRequest,
  handleDiscardWorkDraftRequest,
  handleDraftCommandObservation,
  handleWorkDraftPreviewRequest,
  selectDraftRouteServices,
} from "../../lib/draft-review-route.js";
import { throwHttpInterrupt } from "../../shared/interrupt-boundary.js";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { type DraftTreeStart, describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

__mergedSuite("draft-commands.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-commands.db.test.ts.
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
      const found = (await s.items(ascension)).find(
        (candidate) => candidate.documentId === chapter,
      );
      if (!found) throw new Error("no chapter item");
      return found;
    };
    const preview = async () => {
      const { itemKey } = await item();
      const body = await handleWorkDraftPreviewRequest(deps, {
        ...scope,
        documentId: chapter,
        itemKey,
      });
      if (body.status !== "active") throw new Error(`no active preview: ${body.status}`);
      return body;
    };
    /** The per-change Apply request a click on the first or last change sends from `from` (a preview). */
    const click = async (
      which: "first" | "last",
      from?: Awaited<ReturnType<typeof preview>>,
      commandId = randomUUID(),
    ) => {
      const seen = from ?? (await preview());
      const op = which === "first" ? seen.operations[0] : seen.operations.at(-1);
      if (!op) throw new Error(`no ${which} change`);
      return {
        draftId: seen.draftId,
        itemKey: seen.itemKey,
        commandId,
        operationIds: [op.operationId],
        liveRevisionToken: seen.liveRevisionToken,
        draftRevisionToken: seen.draftRevisionToken,
      };
    };
    const applyChange = (request: Awaited<ReturnType<typeof click>>) =>
      handleApplyWorkDraftChangesRequest(deps, { ...scope, documentId: chapter, request });
    return { runtime, s, ascension, chapter, deps, scope, item, preview, click, applyChange };
  }

  describeDraftTreeDb("review commands (postgres)", (start, db) => {
    it("1: per-change Apply is one batch per click; the last click resets the item and the draft stays active", async () => {
      const c = await twoChanges(start);
      const first = await c.applyChange(await c.click("first"));
      expect(first.body).toMatchObject({ status: "applied", itemClosed: false });
      expect(await c.s.batchStates()).toEqual(["completed"]);
      const live = c.s.view("live");
      expect(await live.text("chapter.md")).toContain("Opening, drafted.");
      expect(await live.text("chapter.md")).not.toContain("End, drafted.");
      const last = await c.applyChange(await c.click("last"));
      expect(last.body).toMatchObject({ status: "applied", itemClosed: true });
      expect(await c.s.batchStates()).toEqual(["completed", "completed"]);
      expect(await c.s.draftStatuses(c.ascension)).toEqual(["active"]);
      expect(await c.s.items(c.ascension)).toEqual([]);
    });
    it.each([
      "edit",
      "rename",
      "delete",
    ] as const)("2: a live %s between selection and staging refuses stale with nothing staged", async (change) => {
      const c = await twoChanges(start);
      const request = await c.click("first");
      const remove = setCollabHook("applyItems.beforeStaging", async () => {
        remove();
        if (change === "edit")
          await c.s.writer.write("chapter.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.");
        if (change === "rename") await c.s.writer.move("chapter.md", "chapter-2.md");
        if (change === "delete") await c.s.writer.delete("chapter.md");
      });
      const answer = await c.applyChange(request);
      expect(answer.body).toMatchObject({ status: "stale" });
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
      expect(raced.a).toMatchObject({
        ok: true,
        value: { body: { status: "applied" } },
      });
      expect(await c.s.batchStates()).toEqual(["completed"]);
      const live = c.s.view("live");
      expect(await live.text("chapter-2.md")).toContain("Opening, drafted.");
      expect((await c.applyChange(await c.click("last"))).body).toMatchObject({
        status: "applied",
        itemClosed: true,
      });
    });
    it("4: a kill after staging recovers exactly the selected change, with live changed meanwhile or not", async () => {
      const c = await twoChanges(start);
      const request = await c.click("first");
      const remove = setCollabHook("applyItems.afterStaging", async () => {
        remove();
        throw new Error("injected process death after staging");
      });
      await expect(c.applyChange(request)).rejects.toThrow("process death");
      expect(await c.s.batchStates()).toEqual(["pending"]);
      await c.s.writer.write("chapter.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.");
      await c.s.expirePendingClaims();
      expect(await c.s.recover()).toBe(1);
      expect(await c.s.batchStates()).toEqual(["completed"]);
      const live = c.s.view("live");
      expect(await live.text("chapter.md")).toContain("Opening, drafted.");
      expect(await live.text("chapter.md")).toContain("Coda.");
      expect(await live.text("chapter.md")).not.toContain("End, drafted.");
      const item = await c.item();
      expect(item.branchGeneration).not.toBeNull();
      expect(await c.s.recover()).toBe(0);
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
      expect(a.body).toMatchObject({ status: "applied", itemClosed: true });
      expect(b).toEqual(a);
      expect(await c.s.batchStates()).toEqual(["completed", "completed"]);
    });
    it("11: an id reused for a different body, kind or Work answers 409 command_conflict", async () => {
      const c = await twoChanges(start);
      const request = await c.click("first");
      await c.applyChange(request);
      const different = { ...request, operationIds: [...request.operationIds, "other"] };
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
      // A per-change Apply that drains and resets the item: its resend finds no item.
      const one = await c.click("first");
      await c.applyChange(one);
      const last = await c.click("last");
      const drained = await c.applyChange(last);
      expect(drained.body).toMatchObject({ status: "applied", itemClosed: true });
      expect(await c.applyChange(last)).toEqual(drained);
      // Discard all closes the draft: its resend finds no draft.
      await c.s.model(c.ascension).edit("chapter.md", "Middle.", "Middle, drafted.");
      const draftId = (await c.s.items(c.ascension))[0]?.draftId as string;
      const request = { draftId, commandId: randomUUID() };
      const closed = await handleDiscardAllWorkDraftRequest(c.deps, {
        ...c.scope,
        request,
      });
      expect(closed.body).toMatchObject({ status: "discarded" });
      expect(await handleDiscardAllWorkDraftRequest(c.deps, { ...c.scope, request })).toEqual(
        closed,
      );
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
        await handleDraftCommandObservation(c.deps, {
          ...c.scope,
          commandId: request.commandId,
        }),
      ).toEqual({ state: "blocked" });
      expect((await c.applyChange(request)).httpStatus).toBe(202);
      expect(await c.s.batchStates()).toEqual(["blocked"]);
    });
  });
});

__mergedSuite("draft-tree.apply-staleness.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/draft-tree.apply-staleness.db.test.ts.
  /** A live chapter with a drafted change in Ascension's draft. */
  async function draftedChapter(start: DraftTreeStart) {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const chapter = await s.writer.createDocument("chapter.md", "Opening.\n\nMiddle.\n\nEnd.");
    await s.model(ascension).edit("chapter.md", "Opening.", "Opening, drafted.");
    const key = itemFor(await s.items(ascension), chapter).itemKey;
    const vector = () =>
      runtime.ports.documentSync.withLiveDocument(chapter, async ({ doc }) =>
        Y.encodeStateVector(doc),
      );
    return {
      s,
      ascension,
      chapter,
      vector,
      staleAnswer: { status: "stale", draftId: expect.any(String), staleItemKeys: [key] },
    };
  }

  describeDraftTreeDb("Apply refuses a stale review (postgres)", (start, db) => {
    it("refuses a live rename, edit or delete-only change made after the review rendered, before staging (E-6a)", async () => {
      const { s, ascension, vector, staleAnswer } = await draftedChapter(start);
      const stale = async (change: () => Promise<unknown>) => {
        const rendered = await s.items(ascension);
        await change();
        return s.applyAll(ascension, { items: rendered });
      };
      expect
        .soft(await stale(() => s.writer.move("chapter.md", "chapter-1.md")), "a live rename")
        .toEqual(staleAnswer);
      expect
        .soft(
          await stale(() => s.writer.write("chapter-1.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.")),
          "a live edit",
        )
        .toEqual(staleAnswer);
      const before = await vector();
      expect
        .soft(
          await stale(() => s.writer.write("chapter-1.md", "Opening.\n\nEnd.\n\nCoda.")),
          "a delete-only edit",
        )
        .toEqual(staleAnswer);
      expect.soft(await vector(), "it inserted nothing (V2-H1)").toEqual(before);
      expect.soft(await s.batchStates(), "nothing staged").toEqual([]);
      expect.soft((await s.review(ascension)).items, "rows reviewable").toHaveLength(1);
    });
    it("an item Apply refused as stale names its own item, the shape the client accepts", async () => {
      const { s, ascension, chapter } = await draftedChapter(start);
      const remove = setCollabHook("applyItems.beforeStaging", async () => {
        remove();
        await s.writer.write("chapter.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda.");
      });
      const [answer] = await s.apply(ascension, [chapter]);
      const { itemKey } = itemFor(await s.items(ascension), chapter);
      expect(answer).toMatchObject({
        httpStatus: 409,
        body: { status: "stale", draftId: expect.any(String), itemKey },
      });
    });
    it("completes a staged batch a live change raced, or that recovery found changed (5b relaxed)", async () => {
      const { s, ascension, vector } = await draftedChapter(start);
      // Staging is the consent boundary: a rename between staging and completion merges.
      const raced = await interleave(
        db,
        () => s.applyAll(ascension),
        "applyItems.afterStaging",
        () => s.writer.move("chapter.md", "chapter-2.md"),
      );
      expect.soft(raced.b.ok, "the rename lands").toBe(true);
      expect.soft(raced.a, "completion publishes").toMatchObject({
        ok: true,
        value: { status: "completed" },
      });
      expect.soft(await s.batchStates(), "completed").toEqual(["completed"]);
      const live = s.view("live");
      expect.soft(await live.text("chapter-2.md")).toContain("Opening, drafted.");
      // A delete-only change while a new staged batch waits for recovery.
      await s.model(ascension).edit("chapter-2.md", "End.", "End, drafted.");
      const rendered = await s.items(ascension);
      const remove = setCollabHook("applyItems.afterStaging", async () => {
        remove();
        throw new Error("injected process death after staging");
      });
      await expect(s.applyAll(ascension, { items: rendered })).rejects.toThrow("process death");
      const beforeDelete = await vector();
      await s.writer.write("chapter-2.md", "Opening, drafted.\n\nEnd.");
      expect.soft(await vector(), "delete-only").toEqual(beforeDelete);
      await s.expirePendingClaims();
      await s.recover();
      expect
        .soft(await s.batchStates(), "recovery completes it")
        .toEqual(["completed", "completed"]);
      expect.soft(await live.text("chapter-2.md")).toContain("End, drafted.");
      expect.soft(await s.items(ascension), "drained").toEqual([]);
    });
    it("lets a content-bearing live create and an Apply of the same document both finish (E-9)", async () => {
      const { s } = await start();
      const ascension = await s.work("Ascension", "draft");
      const harbor = await s.writer.createDocument("harbor.md", "The harbor.");
      const kael = await s.model(ascension).create("characters/kael.md", "Kael, drafted.");
      const rendered = await s.items(ascension);
      const raced = await interleave(
        db,
        () =>
          s.writer.create("characters/kael.md", {
            content: "Writer's Kael by the [harbor](../harbor.md).",
          }),
        "createLive.afterLease",
        () => s.applyAll(ascension, { items: rendered }),
      );
      expect.soft(raced.a, "the create reveals D's document").toEqual({
        ok: true,
        value: { status: "created", documentId: kael },
      });
      expect.soft(raced.b, "the Apply finishes: its render moved").toMatchObject({
        ok: true,
        value: { status: "stale" },
      });
      const live = s.view("live");
      const text = await live.text("characters/kael.md");
      expect.soft(text, "exactly the created content").toContain("Writer's Kael by the");
      expect.soft(text).not.toContain("Kael, drafted.");
      expect
        .soft(
          await s.liveMeaning({
            ref: `doc:${harbor}`,
            href: "manuscript://harbor.md",
            holder: { uri: "manuscript://characters/kael.md", id: kael as DocumentId },
          }),
          "its link bound before the transaction",
        )
        .toEqual({ id: harbor });
      expect.soft((await s.applyAll(ascension)).status, "a fresh review applies").toBe("completed");
      expect.soft(await live.text("characters/kael.md")).toContain("Kael, drafted.");
    });
  });
});
