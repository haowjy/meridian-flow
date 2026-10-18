/**
 * A writer's instant create at a path where a branch's new document waits is that
 * document (#757). The draft's document is a real document, hidden only because it is a
 * draft; the create unhides it and the device's minted id forwards to it. Nothing of the
 * draft's text moves: the writer's text goes to live, the draft's stays in the draft.
 * Driven through the create-untitled route core, as the sidebar's New file calls it.
 */
import type { DocumentId } from "@meridian/contracts";
import { documents } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { itemFor } from "../../test-support/branch-tree-scenario.js";
import { describeBranchTreeDb } from "../../test-support/branch-tree-suite.js";
import { createDrizzleContextCatalog } from "./adapters/context-catalog.js";

describeBranchTreeDb("a create joins a draft's document (postgres)", (start, db) => {
  it("answers joined, turns the branch's item into an edit, and replays unchanged, after a move and after a delete", async () => {
    const { s } = await start();
    const drafting = await s.work("Drafting", "draft");
    const hidden = await s.model(drafting).create("chapters/Withern", "The draft's Withern.");
    expect.soft(itemFor(await s.items(drafting), hidden).isNew, "hidden while a draft").toBe(true);

    const device = crypto.randomUUID() as DocumentId;
    const joined = await s.writer.createInstant("chapters/Withern", device);
    const first = {
      status: "joined",
      documentId: hidden,
      address: { scheme: "manuscript", path: "chapters/Withern", name: "Withern" },
    };
    expect.soft(joined, "the draft's document, at its address").toEqual(first);

    expect.soft(await s.view("live").idAt("chapters/Withern"), "live, the draft's id").toBe(hidden);
    expect
      .soft(itemFor(await s.items(drafting), hidden).isNew, "the review item is now an edit")
      .toBe(false);
    expect
      .soft(await db.select().from(documents).where(eq(documents.id, device)), "no twin row")
      .toEqual([]);
    const catalog = await createDrizzleContextCatalog(db).snapshot({
      kind: "project",
      projectId: s.project.id,
    });
    expect
      .soft(
        catalog.entries.find((entry) => entry.kind === "file" && entry.entryId === hidden),
        "the catalog entry names the id that forwarded to it",
      )
      .toMatchObject({ joinedFrom: [device] });

    expect.soft(await s.writer.createInstant("chapters/Withern", device), "replay").toEqual(first);

    await s.writer.move("chapters/Withern", "chapters/Withern Keep");
    expect
      .soft(await s.writer.createInstant("chapters/Withern", device), "replay after a move")
      .toEqual({
        ...first,
        address: { scheme: "manuscript", path: "chapters/Withern Keep", name: "Withern Keep" },
      });

    await s.writer.delete("chapters/Withern Keep");
    expect
      .soft(await s.writer.createInstant("chapters/Withern", device), "replay after a delete")
      .toMatchObject({ status: "joined", documentId: hidden });
  });

  it("answers two overlapping replays with one forward and one document", async () => {
    const { s } = await start();
    const drafting = await s.work("Drafting", "draft");
    const hidden = await s.model(drafting).create("Withern", "The draft's Withern.");
    const device = crypto.randomUUID() as DocumentId;

    const answers = await Promise.all([
      s.writer.createInstant("Withern", device),
      s.writer.createInstant("Withern", device),
    ]);
    expect(answers).toEqual([
      expect.objectContaining({ status: "joined", documentId: hidden }),
      expect.objectContaining({ status: "joined", documentId: hidden }),
    ]);
    expect(await s.view("live").idAt("Withern")).toBe(hidden);
    expect(await db.select().from(documents).where(eq(documents.id, device))).toEqual([]);
  });

  it("leaves an untitled create off the names hidden documents hold", async () => {
    const { s } = await start();
    const drafting = await s.work("Drafting", "draft");
    const hidden = await s.model(drafting).create("Untitled 1", "The draft's.");

    const answer = await s.writer.createNameless(crypto.randomUUID() as DocumentId);
    expect.soft(answer).toMatchObject({ status: "created", name: "Untitled 2" });
    expect.soft(await s.view("live").idAt("Untitled 1"), "the draft's stays hidden").toBeNull();
    expect(itemFor(await s.items(drafting), hidden).isNew).toBe(true);
  });
});
