/**
 * A live delete leaves other branches' drafts alone (D79): the branch with pending changes
 * still lists the document, at a freed path, under a deleted folder, or under a move's
 * victim, and its draft stays writable; admission opens only a draft destination in a branch
 * that has an active draft of the document.
 */
import type { DocumentId, WorkId } from "@meridian/contracts";
import { documentDrafts } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { itemFor } from "../../test-support/branch-tree-scenario.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { isFileAccessDenied } from "../file-policy/index.js";

describeBranchTreeDb("A live delete and the drafts that outlive it (postgres)", (start, db) => {
  async function draftStatuses(documentId: DocumentId) {
    const rows = await db
      .select({ kind: documentDrafts.kind, status: documentDrafts.status })
      .from(documentDrafts)
      .where(eq(documentDrafts.documentId, documentId));
    return rows.map((row) => `${row.kind}:${row.status}`).sort();
  }

  it("keeps the drafting branch's document listed and writable, and admits only its draft destination", async () => {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const rival = await s.work("Rival", "draft");
    const ch3 = await s.writer.createDocument("ch3", "Paragraph B.");
    await s.model(ascension).edit("ch3", "Paragraph B.", "Paragraph B crossed the river.");
    expect((await s.writer.delete("ch3")).ok).toBe(true);
    // Listing reads the projected pending flag, which trails a write by about a second.
    await runtime.ports.documentSync.draftEffects.flush();

    expect.soft(await s.view("live").idAt("ch3"), "gone live").toBeNull();
    expect.soft(await s.view(rival).idAt("ch3"), "gone where nothing is pending").toBeNull();
    expect.soft(await s.view(ascension).idAt("ch3"), "still the branch's").toBe(ch3);
    expect.soft(await s.view(ascension).text("ch3")).toContain("crossed the river");
    expect.soft(await draftStatuses(ch3), "no draft closed").not.toContain("work_draft:closed");
    expect.soft(itemFor(await s.items(ascension), ch3).conflict).toEqual({ code: "deleted_live" });

    // A second chat of the Work has no peer yet: its first write makes one.
    const second = await s.thread(ascension);
    await s.model(second).edit("ch3", "crossed the river", "crossed the burning river");
    expect.soft(await s.view(ascension).text("ch3")).toContain("burning river");
    const read = await s.model(second).now("read", { path: "manuscript://ch3" });
    expect.soft(String(read.output), "read says why").toContain("Deleted from the manuscript");
    // Its own edit undoes in the draft it landed in.
    const undone = await s
      .model(second)
      .now("write", { command: "undo", path: "manuscript://ch3" });
    expect.soft(undone.isError ?? false, JSON.stringify(undone.output)).toBe(false);
    expect.soft(await s.view(ascension).text("ch3")).not.toContain("burning");

    const access = runtime.ports.fileAccess;
    const writer = { accountId: s.project.userId };
    const draftIn = (workId: WorkId) => ({ kind: "draft" as const, documentId: ch3, workId });
    expect
      .soft(isFileAccessDenied(await access.authorize(writer, draftIn(ascension.id), "edit")))
      .toBe(false);
    expect
      .soft(
        await access.authorize(writer, draftIn(rival.id), "edit"),
        "another Work's branch has no draft of it",
      )
      .toMatchObject({ denied: true, reason: "not_found" });
    expect
      .soft(
        await access.authorize(writer, { kind: "document", documentId: ch3 }, "read"),
        "the live document",
      )
      .toMatchObject({ denied: true, reason: "not_found" });
    const branch = await s.branchOf(ascension);
    expect
      .soft(
        (
          await access.listAccess(writer, [ch3], {
            branchViews: new Map([[ch3, { kind: "branch", branchId: branch.id }]]),
          })
        ).has(ch3),
        "a branch view read for a live destination",
      )
      .toBe(false);
  });

  it("lists a drafted document at a freed path as a clash, under a deleted folder, and as a move's victim", async () => {
    const { runtime, s } = await start();
    const ascension = await s.work("Ascension", "draft");
    const ch3 = await s.writer.createDocument("ch3", "Three.");
    const ch4 = await s.writer.createDocument("ch4", "Four.");
    await s.writer.createDocument("ch5", "Five.");
    const harbor = await s.writer.createDocument("lore/harbor", "The harbor.");
    await s.model(ascension).edit("ch3", "Three.", "Three, drafted.");
    await s.model(ascension).edit("ch4", "Four.", "Four, drafted.");
    await s.model(ascension).edit("lore/harbor", "The harbor.", "The harbor, drafted.");
    await runtime.ports.documentSync.draftEffects.flush();

    expect((await s.writer.delete("lore")).ok).toBe(true);
    expect
      .soft(await s.view(ascension).idAt("lore/harbor"), "under its deleted folder")
      .toBe(harbor);
    expect.soft(await s.view(ascension).text("lore/harbor")).toContain("harbor, drafted");

    expect((await s.writer.delete("ch3")).ok).toBe(true);
    const fresh = await s.writer.createDocument("ch3", "A new three.");
    expect.soft(await s.view("live").idAt("ch3")).toBe(fresh);
    expect
      .soft(await s.view(ascension).stat("ch3"), "two documents at one path in the branch")
      .toMatchObject({ ok: false, error: { reason: "ambiguous_path" } });
    expect.soft(itemFor(await s.items(ascension), ch3).conflict).toMatchObject({
      code: "path_taken",
    });

    const live = runtime.ports.contextPorts.forProject(s.project.id, s.project.userId, new Map());
    const moved = await live.move("manuscript://ch5", "manuscript://ch4", {
      overwrite: true,
      origin: { type: "human", userId: s.project.userId },
    });
    expect(moved.ok).toBe(true);
    expect
      .soft(await draftStatuses(ch4), "the victim keeps its draft")
      .toContain("work_draft:active");
    expect.soft(itemFor(await s.items(ascension), ch4).conflict).toMatchObject({
      code: "path_taken",
    });
  });
});
