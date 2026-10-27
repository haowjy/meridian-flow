/**
 * The stored `grep_text` and the slow path's per-block text agree line for line.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - grep skips reading a document whose stored `grep_text` is usable, which holds only while
 *   the two paths produce the same lines, including empty paragraphs (`^$` counts).
 */
import { grepText } from "@meridian/agent-edit";
import { folderDocumentName } from "@meridian/contracts/protocol";
import { createDb } from "@meridian/database";
import { documentMarkdownProjections, documents, folders } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
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

const SHAPES: Array<{ name: string; filetype?: string; markdown: string }> = [
  {
    name: "links",
    markdown:
      "A [label](https://example.com/a(b)) and [second](https://example.org/z).\n\n![Map](assets/map.png) *kept* LIVE_ONLY",
  },
  { name: "escapes", markdown: "Under\\_score \\*star\\* &#x20;space &amp; amp\n\n# Head" },
  { name: "break", markdown: "first line  \nsecond line\\\nthird line" },
  { name: "gaps", markdown: "one\n\n \n\ntwo" },
  { name: "blocks", markdown: "- a\n- b\n\n> quote\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```" },
  { name: "code", filetype: "ts", markdown: "const a = 1;\n\nconst b = [x, y];\n" },
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

    it("stores the lines the effective hashline read computes", async () => {
      const collab = createTestCollab();
      collab.bindHocuspocus(hocuspocus as never);
      // The one image the "links" shape shows: a path that resolves spells a different destination than a stored one.
      const assets = "00000000-0000-4000-8000-000000000711";
      await db.insert(folders).values({
        id: assets,
        contextSourceId: SOURCE_ID,
        name: "assets",
        documentAlias: folderDocumentName("assets"),
      });
      await db.insert(documents).values({
        id: "00000000-0000-4000-8000-000000000712",
        contextSourceId: SOURCE_ID,
        folderId: assets,
        name: "map",
        extension: "png",
        fileType: "image",
        mimeType: "image/png",
      });
      for (const [index, shape] of SHAPES.entries()) {
        const documentId = `00000000-0000-4000-8000-0000000008${String(index).padStart(2, "0")}`;
        await db.insert(documents).values({
          id: documentId,
          contextSourceId: SOURCE_ID,
          name: shape.name,
          extension: shape.filetype ? "ts" : "",
          fileType: "markdown",
          ...(shape.filetype ? { filetype: "typescript" } : {}),
        });
        await writeMarkdown(collab, {
          documentId: documentId as never,
          markdown: shape.markdown,
          origin: { type: "user", actorUserId: USER_ID as never },
          threadId: THREAD_ID as never,
        });
        await collab.documentDerivations.derive(documentId as never);
        const [row] = await db
          .select({ grepText: documentMarkdownProjections.grepText })
          .from(documentMarkdownProjections)
          .where(eq(documentMarkdownProjections.documentId, documentId as never));
        const read = await collab.readEffectiveHashlines({
          documentId: documentId as never,
          threadId: THREAD_ID as never,
          destination: "live",
        });
        if (!read.ok) throw new Error(JSON.stringify(read.error));
        expect(row?.grepText, shape.name).toBe(
          grepText(read.value.blocks.map((block) => block.destinationFree)),
        );
        expect(row?.grepText, shape.name).not.toBeNull();
      }
    });
  });
}
