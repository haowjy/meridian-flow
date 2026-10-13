/** Immediate failed-response rollback across live and draft parts, with exact writer-dependent content. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { asGrantedWriter, testFileGrant } from "../../test-support/file-grants.js";
import { writeMarkdown } from "./test-support/bound-writes.js";
import {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
async function fixture() {
  const harness = createHarness(db),
    view = harness.crossWorkProbeFixture(),
    responseId = randomUUID();
  await db.insert(schema.modelResponses).values({
    id: responseId as never,
    turnId: TURN_ID,
    sequence: 1,
    provider: "mock",
    model: "mock",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "facts_unavailable",
  });
  await harness.seedWriterDocument("Alpha Beta.\n\nBlue.", responseId);
  const context = {
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
  };
  return { harness, view, responseId, context };
}
it.each(
  ["insert", "delete", "replace"].flatMap((kind) =>
    [false, true].map((edited) => ({ kind, edited })),
  ),
)("immediate live $kind rollback respects writer dependencies (edited=$edited)", async ({
  kind,
  edited,
}) => {
  const { harness, view, responseId, context } = await fixture();
  try {
    const immediate = {
      ...context,
      responseIdentity: undefined,
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
      actor: {
        kind: "agent" as const,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        responseId,
        editScopeId: responseId,
      },
    };
    await view.collab.agentEdit().read({ file: "alpha.md", documentId: ALPHA_ID }, immediate);
    const content = kind === "delete" ? "" : "Gamma";
    for (const [find, replacement] of [
      ["Beta", content],
      ["Blue", kind === "delete" ? "" : "Silver"],
    ]) {
      const outcome = await asGrantedWriter(() =>
        view.collab.agentEdit().write(
          {
            command: kind === "insert" ? "insert" : "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find,
            content: replacement,
            tool_use_id: find,
          },
          immediate,
        ),
      );
      expect(outcome).toMatchObject({ status: "success", phase: "committed" });
    }
    if (edited)
      await writeMarkdown(view.collab, {
        documentId: ALPHA_ID,
        markdown:
          kind === "insert"
            ? "Alpha BetaGamma!.\n\nBlueSilver."
            : kind === "delete"
              ? "Alpha !.\n\n."
              : "Alpha Ga!mma.\n\nSilver.",
        origin: { type: "user", actorUserId: USER_ID as never },
        threadId: THREAD_ID,
      });
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
      !edited
        ? "Alpha Beta.\n\nBlue.\n"
        : kind === "insert"
          ? "Alpha BetaGamma!.\n\nBlue.\n"
          : kind === "delete"
            ? "Alpha !.\n\nBlue.\n"
            : "Alpha Ga!mma.\n\nBlue.\n",
    );
    const rollbackParts = await db
      .select()
      .from(schema.documentEditParts)
      .innerJoin(schema.documentEdits, eq(schema.documentEditParts.editId, schema.documentEdits.id))
      .where(eq(schema.documentEdits.kind, "rollback"));
    expect(rollbackParts).toHaveLength(edited ? 1 : 2);
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(
      await db
        .select()
        .from(schema.documentEditParts)
        .innerJoin(
          schema.documentEdits,
          eq(schema.documentEditParts.editId, schema.documentEdits.id),
        )
        .where(eq(schema.documentEdits.kind, "rollback")),
    ).toHaveLength(edited ? 1 : 2);
    expect((await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID))?.control).not.toBe("redo");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("failed response rolls back immediate live and draft parts while keeping a writer-dependent draft part", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    await writeMarkdown(view.collab, {
      documentId: BETA_ID,
      markdown: "Delta Echo.\n\nGreen.",
      origin: { type: "user", actorUserId: USER_ID as never },
      threadId: THREAD_ID,
    });
    const actor = {
      kind: "agent" as const,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      responseId,
      editScopeId: responseId,
    };
    await view.collab.agentEdit().read(
      { file: "alpha.md", documentId: ALPHA_ID },
      {
        ...context,
        responseIdentity: undefined,
        actor,
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
      },
    );
    await view.collab.agentEdit().read(
      { file: "beta.md", documentId: BETA_ID },
      {
        ...context,
        responseIdentity: undefined,
        actor,
        grant: testFileGrant(
          { kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" },
          BETA_ID,
        ),
      },
    );
    expect(
      await asGrantedWriter(() =>
        view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find: "Beta",
            content: "Gamma",
            tool_use_id: "live",
          },
          {
            ...context,
            responseIdentity: undefined,
            actor,
            grant: testFileGrant({ kind: "live" }, ALPHA_ID),
          },
        ),
      ),
    ).toMatchObject({ status: "success", phase: "committed" });
    for (const [find, content] of [
      ["Echo", "Amber"],
      ["Green", "Gold"],
    ])
      expect(
        await asGrantedWriter(() =>
          view.collab.agentEdit().write(
            {
              command: "replace",
              documentId: BETA_ID,
              file: "beta.md",
              find,
              content,
              tool_use_id: find,
            },
            {
              ...context,
              responseIdentity: undefined,
              actor,
              grant: testFileGrant(
                { kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" },
                BETA_ID,
              ),
            },
          ),
        ),
      ).toMatchObject({ status: "success", phase: "committed" });
    const [draft] = (
      await view.collab.draftReview.list({ projectId: PROJECT_ID as never, workId: WORK_ID })
    ).filter((d) => d.documentId === BETA_ID);
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(eq(schema.documentBranches.id, draft.draftId));
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, branch.state);
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
      await view.branchCoordinator.commitWriterUpdate({
        branchId: branch.id,
        expectedGeneration: branch.generation,
        updateData: Y.mergeUpdates(updates),
        actorUserId: USER_ID,
        roomDocument: doc,
      });
    } finally {
      doc.destroy();
    }
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    expect(await harness.liveMarkdown(BETA_ID)).toBe("Delta Echo.\n\nGreen.\n");
    expect(await view.draftMarkdown(branch.id)).toBe("Delta Am!ber.\n\nGreen.\n");
    expect(
      await db
        .select()
        .from(schema.branchWriteJournal)
        .where(eq(schema.branchWriteJournal.status, "rollback_pending")),
    ).toHaveLength(1);
    expect(
      await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.kind, "rollback")),
    ).toHaveLength(2);
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
