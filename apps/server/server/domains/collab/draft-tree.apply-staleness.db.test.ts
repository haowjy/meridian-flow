/**
 * Apply refuses a stale review (#420, contract §11.3, ledger E-6a, E-6b, E-9): a live
 * rename, edit or delete-only change after the review rendered refuses before staging; one
 * racing the staged batch, or landing while it waits for recovery, merges and the batch
 * completes (staging is the consent boundary); and a content-bearing live create racing an Apply of the same document
 * lets both finish.
 */
import type { DocumentId } from "@meridian/contracts";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { itemFor } from "../../test-support/draft-tree-scenario.js";
import { type DraftTreeStart, describeDraftTreeDb } from "../../test-support/draft-tree-suite.js";
import { interleave } from "../../test-support/lock-interleave.js";
import { setCollabHook } from "./domain/collab-test-hooks.js";

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
  it("refuses a live rename made after the review rendered, before staging, but merges a live edit into the chosen change (E-6a)", async () => {
    const { s, ascension, staleAnswer } = await draftedChapter(start);
    const rendered = async (change: () => Promise<unknown>) => {
      const items = await s.items(ascension);
      await change();
      return s.applyAll(ascension, { items });
    };
    expect
      .soft(await rendered(() => s.writer.move("chapter.md", "chapter-1.md")), "a live rename")
      .toEqual(staleAnswer);
    expect.soft(await s.batchStates(), "nothing staged").toEqual([]);
    expect.soft((await s.review(ascension)).items, "rows reviewable").toHaveLength(1);
    // Live text is not part of the review's frame: Apply merges the chosen change into it.
    expect
      .soft(
        await rendered(() =>
          s.writer.write("chapter-1.md", "Opening.\n\nMiddle.\n\nEnd.\n\nCoda."),
        ),
        "a live edit",
      )
      .toMatchObject({ status: "completed", items: [{ status: "applied" }] });
    expect.soft(await s.view("live").text("chapter-1.md")).toContain("Coda.");
  });

  it("an item Apply refused as stale names its own item, the shape the client accepts", async () => {
    const { s, ascension, chapter } = await draftedChapter(start);
    const remove = setCollabHook("applyItems.beforeStaging", async () => {
      remove();
      await s.writer.move("chapter.md", "chapter-1.md");
    });
    const [answer] = await s.apply(ascension, [chapter]);
    const { itemKey } = itemFor(await s.items(ascension), chapter);
    expect(answer).toMatchObject({
      httpStatus: 409,
      body: { status: "stale", draftId: expect.any(String), itemKey },
    });
  });

  it("completes a staged batch a live change raced, or that recovery found changed (5b relaxed)", async () => {
    const { s, ascension, chapter, vector } = await draftedChapter(start);
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
    expect.soft(await s.batchStates(), "recovery completes it").toEqual(["completed", "completed"]);
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
