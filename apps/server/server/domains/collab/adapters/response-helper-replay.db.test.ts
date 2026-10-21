// Revocable response helpers and accepted replay across concurrent draft writes.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  WORK_ID,
} from "../test-support/change-trail-postgres-harness.js";
import {
  createResponse,
  responseContext,
  setupResponseDraft,
} from "../test-support/document-edit-receipt-fixture.js";

async function _expectScopedReplay(
  fixture: ReturnType<ReturnType<typeof createHarness>["crossWorkProbeFixture"]>,
  responseId: string,
) {
  const { createEffectiveDocumentReader } = await import("../domain/effective-document-reader.js");
  const reader = createEffectiveDocumentReader({
    drafts: fixture.draftStore,
    draftPulls: fixture.draftPulls,
    agentEdit: fixture.collab.agentEdit(),
    documents: fixture.runtime.markdownDocuments,
    model: fixture.runtime.model,
    codec: fixture.runtime.codec,
    links: fixture.links,
    branches: {
      viewForWork: async (workId) => {
        const { branchId } = await fixture.collab.draftReview.items({ workId: workId as never });
        return branchId ? { kind: "branch", branchId } : { kind: "live" };
      },
    },
  });
  const args = {
    documentId: ALPHA_ID,
    threadId: THREAD_ID,
    responseId,
    destination: "draft" as const,
    workId: WORK_ID,
  };
  const markdown = await reader.readEffectiveMarkdown(args);
  expect(markdown).toMatchObject({ ok: true });
  if (markdown.ok) expect(markdown.value.content).toBe("red\n\nazure\n\nlime\n");
  const hashlines = await reader.readEffectiveHashlines(args);
  expect(hashlines).toMatchObject({ ok: true });
  if (hashlines.ok)
    expect(hashlines.value.content.map((block) => block.slice(block.indexOf("|") + 1))).toEqual([
      "red",
      "azure",
      "lime",
    ]);
}

describe("response helper replay (Postgres)", () => {
  const db = createTestDatabase();
  let harness: ReturnType<typeof createHarness>;
  beforeEach(async () => {
    await resetDatabase(db);
    harness = createHarness(db);
  });
  afterEach(() => {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  });
  afterAll(() => closeDatabase(db));
  it("a save whose second document moves between capture and commit folds the move and commits once", async () => {
    const { fixture, draftId, responseId, context, write } = await setupResponseDraft(db, harness);
    const core = fixture.collab.agentEdit();
    const writeBeta = (
      command: "create" | "replace",
      content: string,
      ctx: ReturnType<typeof responseContext>,
    ) =>
      core.write(
        {
          command,
          file: "beta.md",
          documentId: BETA_ID,
          ...(command === "create"
            ? { content, overwrite: true }
            : { find: "Beta seeded.", content }),
          tool_use_id: `beta-${command}`,
        },
        { ...ctx, createdDocument: false },
      );
    // Beta's draft is durable before this reply saves: an earlier reply made it.
    const earlier = await createResponse(db, 3);
    expect(await writeBeta("create", "Beta seeded.", responseContext(earlier))).toMatchObject({
      phase: "staged",
    });
    expect(await harness.commit(earlier)).toMatchObject({ status: "committed" });
    const beta = await fixture.draftStore.resolveWorkDraftForThread(BETA_ID, THREAD_ID);
    expect(await write("green", "lime")).toMatchObject({ status: "success", phase: "staged" });
    expect(await writeBeta("replace", "Beta staged.", context)).toMatchObject({ phase: "staged" });
    const rowsOf = async (id: string) =>
      (
        await db
          .select({ id: schema.draftWriteJournal.id })
          .from(schema.draftWriteJournal)
          .where(
            and(
              eq(schema.draftWriteJournal.draftId, id),
              eq(schema.draftWriteJournal.source, "agent"),
            ),
          )
      ).length;
    const before = { alpha: await rowsOf(draftId), beta: await rowsOf(beta.draftId) };

    const original = fixture.draftStore.appendRows.bind(fixture.draftStore);
    const appends: string[] = [];
    fixture.draftStore.appendRows = async (request) => {
      appends.push(request.draftId === draftId ? "alpha" : "beta");
      if (appends.length === 2 && request.draftId === beta.draftId) {
        // A frame on another connection moves Beta after the attempt judged it.
        await db
          .update(schema.documentDrafts)
          .set({ revision: sql`${schema.documentDrafts.revision} + 1` })
          .where(eq(schema.documentDrafts.id, beta.draftId));
      }
      return original(request);
    };
    let saved: Awaited<ReturnType<typeof harness.commit>>;
    try {
      saved = await harness.commit(responseId);
    } finally {
      fixture.draftStore.appendRows = original;
    }
    // An append is sequenced, not fenced: Beta's move is folded into its committed prefix
    // under the row lock, and the save commits in its first attempt.
    expect(appends).toEqual(["alpha", "beta"]);
    expect(saved).toMatchObject({ status: "committed" });
    expect(await rowsOf(draftId)).toBe(before.alpha + 1);
    expect(await rowsOf(beta.draftId)).toBe(before.beta + 1);
    expect(await fixture.draftMarkdown(draftId)).toBe("gold\n\nazure\n\nlime\n");
    expect(await fixture.draftMarkdown(beta.draftId)).toBe("Beta staged.\n");
  });
});
