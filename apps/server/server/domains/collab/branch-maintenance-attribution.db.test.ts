/** A live move during a draft response must converge without inventing writer edits. */
import { createDb } from "@meridian/database";
import { documents, documentYjsUpdates } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { testFileGrant } from "../../test-support/file-grants.js";
import { DrizzleContextTreeMutationStore } from "../context/adapters/context-fs/drizzle-tree-mutation-store.js";
import { createLinkUpdateWorker } from "../context/links/link-update-worker.js";
import { createNoopEventSink } from "../observability/index.js";
import {
  createWorkDraftFixture,
  DOC_ID,
  DRAFT_DESTINATION,
  SOURCE_ID,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/work-draft-fixture.js";

// The DB project requires RUN_DB_TESTS and installs an owned worker DATABASE_URL.
describe("draft maintenance attribution (postgres)", () => {
  const db = createDb(process.env.DATABASE_URL as string, { max: 4 });
  const fixture = createWorkDraftFixture(db);
  beforeEach(fixture.reset);
  afterEach(fixture.dispose);
  afterAll(() => db.close());

  it("converges a persisted link rewrite with a staged same-block draft edit without writer credit", async () => {
    const collab = fixture.createTestCollab();
    collab.bindHocuspocus(fixture.hocuspocus as never);
    await db.insert(documents).values({
      id: "00000000-0000-4000-8000-000000000711",
      contextSourceId: SOURCE_ID,
      name: "target",
      extension: "md",
      fileType: "markdown",
    });
    await collab.writeDocument({
      documentId: DOC_ID as never,
      markdown: "[Target](target.md) waits.\n\nOther paragraph.",
      origin: { type: "user", actorUserId: USER_ID as never },
    });
    const context = {
      sessionId: "maintenance",
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId: "00000000-0000-4000-8000-000000000712",
      grant: testFileGrant(DRAFT_DESTINATION, DOC_ID),
    };
    const core = collab.agentEdit();
    expect(await core.read({ file: "chapter.md", documentId: DOC_ID }, context)).toMatchObject({
      status: "success",
    });
    expect(
      await core.write(
        {
          command: "replace",
          file: "chapter.md",
          documentId: DOC_ID,
          find: "waits",
          content: "advances",
        },
        context,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });

    const tree = new DrizzleContextTreeMutationStore(db);
    const source = await tree.inspect(SOURCE_ID, "target.md");
    if (source?.kind !== "file") throw new Error("Missing target");
    expect(
      await tree.commitMove({
        source,
        destinationSourceId: SOURCE_ID,
        destinationPath: "renamed.md",
        expectedTarget: { state: "absent" },
        overwrite: false,
        destinationFiletype: "markdown",
        graduateProvisionalName: false,
        mover: { userId: USER_ID },
      }),
    ).toMatchObject({ ok: true });
    const worker = createLinkUpdateWorker({
      db,
      eventSink: createNoopEventSink(),
      rewriteDocumentLinks: collab.rewriteDocumentLinks,
    });
    try {
      await worker.sweep();
    } finally {
      await worker.stop();
    }
    expect(
      await db.select().from(documentYjsUpdates).where(eq(documentYjsUpdates.documentId, DOC_ID)),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ originType: "link_update" })]));
    const saved = await collab.finalizeResponseCommit(context.responseId, {
      threadId: THREAD_ID as never,
      turnId: TURN_ID as never,
    });
    const receipt = saved.documents
      .find((doc) => doc.documentId === DOC_ID)
      ?.receipts.at(-1)?.result;
    expect(receipt).toBeDefined();
    expect(
      saved.documents.find((doc) => doc.documentId === DOC_ID)?.concurrentEdits,
    ).toBeUndefined();
    const draft = await collab.readEffectiveMarkdown({
      documentId: DOC_ID as never,
      threadId: THREAD_ID as never,
      destination: "draft",
    });
    expect(draft).toMatchObject({
      ok: true,
      value: {
        content: "[Target](renamed.md) advances.\n\nOther paragraph.\n",
      },
    });
  });
});
