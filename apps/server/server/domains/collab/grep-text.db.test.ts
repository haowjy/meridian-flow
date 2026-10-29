/**
 * The stored block text and the room copy's per-block text agree byte for byte.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - grep skips reading a document whose stored text is usable, which holds only while the two
 *   paths produce the same lines, including empty paragraphs (`^$` counts) and a code file's
 *   text with no fence.
 * - a save rewrites only the blocks it changed, and the order array only when the order moved.
 */
import { createDb } from "@meridian/database";
import { documentBlockRooms, documentBlocks, documents } from "@meridian/database/schema";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMarkdown } from "./test-support/bound-writes.js";
import {
  createWorkBranchFixture,
  SOURCE_ID,
  THREAD_ID,
  USER_ID,
} from "./test-support/work-branch-fixture.js";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

// One pipeline builds both texts (`grepBlocksOf`); these shapes guard what only the SQL side can
// break: an empty paragraph keeps its line, and a code file stores its text with no fence.
const SHAPES: Array<{ name: string; filetype?: string; markdown: string }> = [
  { name: "gaps", markdown: "one\n\n \n\ntwo" },
  { name: "code", filetype: "typescript", markdown: "const a = 1;\n\nconst b = [x, y];\n" },
];

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("grep text (postgres)", () => {});
} else {
  describe("grep text (postgres)", () => {
    const db = createDb(DATABASE_URL, { max: 4 });
    const { hocuspocus, createTestCollab, reset, dispose } = createWorkBranchFixture(db);
    beforeEach(reset);
    afterEach(dispose);
    afterAll(async () => {
      await db.$client.end();
    });

    it("stores the text the effective hashline read computes", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      for (const [index, shape] of SHAPES.entries()) {
        const documentId = `00000000-0000-4000-8000-0000000008${String(index).padStart(2, "0")}`;
        await db.insert(documents).values({
          id: documentId,
          contextSourceId: SOURCE_ID,
          name: shape.name,
          extension: shape.filetype ? "ts" : "",
          fileType: shape.filetype ?? "markdown",
        });
        await writeMarkdown(collab, {
          documentId: documentId as never,
          markdown: shape.markdown,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.documentDerivations.derive(documentId as never);
        const stored = await collab.readStoredGrepTexts({
          documentIds: [documentId as never],
          destination: "live",
        });
        const read = await collab.readEffectiveHashlines({
          documentId: documentId as never,
          threadId: THREAD_ID as never,
          destination: "live",
        });
        if (!read.ok) throw new Error(JSON.stringify(read.error));
        expect(stored.get(documentId as never), shape.name).toBe(
          read.value.blocks.map((block) => block.text).join("\n"),
        );
      }
    });

    it("rewrites only the blocks a save changed, and the order only when it moved", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      const documentId = "00000000-0000-4000-8000-000000000900";
      await db.insert(documents).values({
        id: documentId,
        contextSourceId: SOURCE_ID,
        name: "diff",
        extension: "",
        fileType: "markdown",
      });
      const save = async (markdown: string) => {
        await writeMarkdown(collab, {
          documentId: documentId as never,
          markdown,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.documentDerivations.derive(documentId as never);
        const blocks = await db.execute<{ text: string; version: string }>(sql`
          select b.text, b.xmin::text as version
          from ${documentBlocks} b join ${documentBlockRooms} r on r.room_id = b.room_id
          where r.document_id = ${documentId}`);
        const [room] = await db
          .select({ order: documentBlockRooms.blockOrder })
          .from(documentBlockRooms)
          .where(eq(documentBlockRooms.documentId, documentId as never));
        return {
          versions: new Map(blocks.map((row) => [row.text, row.version])),
          order: room?.order,
        };
      };
      const first = await save("alpha\n\nbeta\n\ngamma");
      const edited = await save("alpha\n\nbeta changed\n\ngamma");
      expect(edited.order).toEqual(first.order);
      expect(edited.versions.get("alpha")).toBe(first.versions.get("alpha"));
      expect(edited.versions.get("gamma")).toBe(first.versions.get("gamma"));
      expect(edited.versions.has("beta changed")).toBe(true);
      const inserted = await save("first\n\nalpha\n\nbeta changed\n\ngamma");
      expect(inserted.order?.slice(1)).toEqual(edited.order);
      for (const text of ["alpha", "beta changed", "gamma"])
        expect(inserted.versions.get(text), text).toBe(edited.versions.get(text));
    });
  });
}
