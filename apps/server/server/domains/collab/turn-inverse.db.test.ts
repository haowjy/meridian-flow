/** Exact durable content through card inverses, placements and response failures. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import {
  ALPHA_ID,
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
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }, ALPHA_ID),
  };
  const target = { projectId: PROJECT_ID as never, workId: WORK_ID, documentId: ALPHA_ID };
  return { harness, view, responseId, context, target };
}
describe("forward card inverse", () => {
  it.each(
    ["insert", "delete", "replace"].flatMap((kind) =>
      ["pending", "applied", "mixed"].map((placement) => ({ kind, placement })),
    ),
  )("$kind $placement Undo/Redo twice then Apply keeps exact bytes", async ({
    kind,
    placement,
  }) => {
    const { harness, view, responseId, context, target } = await fixture();
    try {
      const changes =
        kind === "insert"
          ? [
              ["Beta", " Gamma"],
              ["Blue", " Silver"],
            ]
          : [
              ["Beta", kind === "delete" ? "" : "Gamma"],
              ["Blue", kind === "delete" ? "" : "Silver"],
            ];
      for (const [index, [find, content]] of changes.entries())
        expect(
          await view.collab.agentEdit().write(
            {
              command: kind === "insert" ? "insert" : "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              ...(find ? { find } : {}),
              content,
              tool_use_id: `part-${index}`,
            },
            context,
          ),
        ).toMatchObject({ status: "success", phase: "staged" });
      await harness.commit(responseId);
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      const draftTarget = { ...target, draftId: branch.id };
      const original = "Alpha Beta.\n\nBlue.\n";
      const edited =
        kind === "insert"
          ? "Alpha Beta Gamma.\n\nBlue Silver.\n"
          : kind === "delete"
            ? "Alpha .\n\n.\n"
            : "Alpha Gamma.\n\nSilver.\n";
      expect(await view.draftMarkdown(branch.id)).toBe(edited);
      if (placement === "applied")
        expect(
          await view.collab.draftReview.applyWorkDraft({
            ...draftTarget,
            userId: USER_ID as never,
          }),
        ).toMatchObject({ status: "applied" });
      if (placement === "mixed") {
        const preview = await view.collab.draftReview.preview(draftTarget);
        if (preview.status !== "active") throw new Error("Missing draft");
        expect(
          await view.collab.draftReview.applyWorkDraftChanges({
            ...draftTarget,
            userId: USER_ID as never,
            operationIds: [preview.operations[0].operationId],
            liveRevisionToken: preview.liveRevisionToken,
            draftRevisionToken: preview.draftRevisionToken,
          }),
        ).toMatchObject({ status: "applied" });
      }
      const mixedLive = await harness.liveMarkdown(ALPHA_ID);
      for (const direction of ["undo", "redo", "undo", "redo"] as const) {
        expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
          control: direction,
        });
        const outcome = await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction,
          actor: { type: "user", userId: USER_ID },
        });
        expect(outcome).toMatchObject({
          status: "reversed",
          acceptedParts: 2,
          skips: [],
          documents: [
            {
              destination:
                placement === "applied" ? { kind: "live" } : { kind: "draft", branchId: branch.id },
            },
          ],
        });
        const inverseParts = await db
          .select({ update: schema.documentEditParts.update })
          .from(schema.documentEditParts)
          .innerJoin(
            schema.documentEdits,
            eq(schema.documentEditParts.editId, schema.documentEdits.id),
          )
          .where(inArray(schema.documentEdits.kind, ["undo", "redo"]));
        for (const { update } of inverseParts) {
          const structs = Y.decodeUpdate(update).structs;
          // Pure inverse deletions have no inserted structs; every authored struct otherwise shares its part client.
          expect(new Set(structs.map((item) => item.id.client)).size).toBeLessThanOrEqual(1);
          for (const item of structs)
            if (
              item instanceof Y.Item &&
              (item.parent as unknown) === "__meridian_provenance_targets_v2"
            ) {
              expect(item.origin).toBeNull();
              expect(item.rightOrigin).toBeNull();
            }
        }

        expect(
          placement === "applied"
            ? await harness.liveMarkdown(ALPHA_ID)
            : await view.draftMarkdown(branch.id),
        ).toBe(direction === "undo" ? original : edited);
        if (placement === "mixed") expect(await harness.liveMarkdown(ALPHA_ID)).toBe(mixedLive);
      }
      if (placement !== "applied")
        expect(
          await view.collab.draftReview.applyWorkDraft({
            ...draftTarget,
            userId: USER_ID as never,
          }),
        ).toMatchObject({ status: "applied" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(edited);
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

it.each([
  "applied",
  "live",
  "redo",
] as const)("another draft holds %s text, then release leaves Redo first with an active part", async (origin) => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
    if (origin !== "applied")
      await view.collab
        .agentEdit()
        .read(
          { documentId: ALPHA_ID, file: "alpha.md" },
          { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) },
        );
    for (const [find, content] of [
      ["Beta", "Gamma"],
      ["Blue", "Gold"],
    ])
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find,
            content,
            tool_use_id: find,
          },
          origin !== "applied"
            ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
            : context,
        ),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    if (origin === "applied") {
      const [ownDraft] = await view.collab.draftReview.list({
        projectId: PROJECT_ID as never,
        workId: WORK_ID,
      });
      expect(
        await view.collab.draftReview.applyWorkDraft({
          ...target,
          draftId: ownDraft.draftId,
          userId: USER_ID as never,
        }),
      ).toMatchObject({ status: "applied" });
    }
    const redoContext = {
      ...context,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
    };
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    if (origin === "redo") {
      await view.collab.agentEdit().read(address, redoContext);
      expect(
        await view.collab.agentEdit().write({ ...address, command: "undo", count: 2 }, redoContext),
      ).toMatchObject({ status: "success" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    }
    const otherWork = randomUUID(),
      otherThread = randomUUID(),
      otherTurn = randomUUID(),
      otherResponse = randomUUID();
    const [work] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID));
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
    await db
      .insert(schema.works)
      .values({ ...work, id: otherWork as never, name: "Holding draft", slug: "holding" });
    await db.insert(schema.threads).values({ ...thread, id: otherThread as never });
    await db.insert(schema.threadWorks).values({
      threadId: otherThread as never,
      workId: otherWork as never,
      projectId: PROJECT_ID,
      isPrimary: true,
    });
    await db
      .insert(schema.turns)
      .values({ ...turn, id: otherTurn as never, threadId: otherThread as never });
    await db.insert(schema.modelResponses).values({
      id: otherResponse as never,
      turnId: otherTurn as never,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    const otherContext = {
      ...context,
      sessionId: otherThread,
      threadId: otherThread as never,
      turnId: otherTurn as never,
      responseIdentity: { providerResponseId: otherResponse, editScopeId: otherResponse },
      grant: testFileGrant({ kind: "draft", workId: otherWork, workSlug: "holding" }),
    };
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: origin === "redo" ? "Beta" : "Gamma",
          content: "Delta",
          tool_use_id: "held",
        },
        otherContext,
      ),
    ).toMatchObject({ status: "success" });
    await view.collab.finalizeResponseCommit(
      { providerResponseId: otherResponse, editScopeId: otherResponse },
      {
        threadId: otherThread as never,
        turnId: otherTurn as never,
      },
    );
    expect(
      await view.collab.reverseTurn({
        threadId: otherThread as never,
        turnId: otherTurn as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    if (origin === "live") {
      const modelContext = {
        ...context,
        responseIdentity: undefined,
        grant: testFileGrant({ kind: "live" }, ALPHA_ID),
      };
      const address = { documentId: ALPHA_ID, file: "alpha.md" };
      await view.collab.agentEdit().read({ ...address, format: "edits" }, modelContext);
      expect(
        await view.collab
          .agentEdit()
          .write({ ...address, command: "undo", count: 2 }, modelContext),
      ).toMatchObject({ status: "cant_undo_held" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nGold.\n");
      expect(
        await view.collab
          .agentEdit()
          .write({ ...address, command: "revert", edit: "w1" }, modelContext),
      ).toMatchObject({ status: "nothing_to_revert" });
    }
    if (origin === "redo") {
      expect(
        await view.collab.agentEdit().write({ ...address, command: "redo" }, redoContext),
      ).toMatchObject({ status: "cant_redo_held" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      const edits = await view.collab
        .agentEdit()
        .read({ ...address, format: "edits" }, redoContext);
      expect(edits.result.message).not.toMatch(/ {2}redo(?:\n|$)/);
      const [holding] = await view.collab.draftReview.list({ ...target, workId: otherWork });
      expect(holding).toBeDefined();
      await view.collab.draftReview.discardWorkDraft({
        ...target,
        workId: otherWork,
        draftId: holding.draftId,
        userId: USER_ID as never,
      });
      expect(
        await view.collab.agentEdit().write({ ...address, command: "redo" }, redoContext),
      ).toMatchObject({ status: "success" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nGold.\n");
      return;
    }
    const partial = await view.collab.reverseTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "undo",
      actor: { type: "user", userId: USER_ID },
    });
    expect(partial).toMatchObject({
      status: "partial",
      acceptedParts: 1,
      skips: [{ before: "Beta", after: "Gamma", reason: expect.stringContaining("@holding") }],
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    const [holding] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: otherWork,
    });
    expect(holding).toBeDefined();
    expect(
      await view.collab.draftReview.discardWorkDraft({
        ...target,
        workId: otherWork,
        draftId: holding.draftId,
        userId: USER_ID as never,
      }),
    ).toMatchObject({ status: "discarded" });
    // Both an active Gamma part and the latest action's undone Gold part now qualify.
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "redo",
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 1 });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nGold.\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("failed-response rollback targets the response, is per-part and terminal on retry", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "first",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    const second = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: second as never,
      turnId: TURN_ID,
      sequence: 2,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Blue",
          content: "Silver",
          tool_use_id: "second",
        },
        { ...context, responseIdentity: { providerResponseId: second, editScopeId: second } },
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(second);
    await view.collab.finalizeResponseRollback(
      { providerResponseId: second, editScopeId: second },
      { threadId: THREAD_ID, turnId: TURN_ID },
    );
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
    expect(await view.draftMarkdown(branch.id)).toBe("Alpha Gamma.\n\nBlue.\n");
    const before = await db
      .select()
      .from(schema.documentEdits)
      .where(eq(schema.documentEdits.kind, "rollback"));
    expect(before).toHaveLength(1);
    await view.collab.finalizeResponseRollback(
      { providerResponseId: second, editScopeId: second },
      { threadId: THREAD_ID, turnId: TURN_ID },
    );
    expect(
      await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.kind, "rollback")),
    ).toHaveLength(1);
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
      skips: [{ reason: "Rolled back" }],
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("card Undo during an open response drops writes into undone text and keeps an independent write", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "first",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    const second = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: second as never,
      turnId: TURN_ID,
      sequence: 2,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    for (const [find, content] of [
      ["Gamma", "Gild"],
      ["Gild", "Bronze"],
      ["Blue", "Silver"],
    ])
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find,
            content,
            tool_use_id: find,
          },
          { ...context, responseIdentity: { providerResponseId: second, editScopeId: second } },
        ),
      ).toMatchObject({ status: "success", phase: "staged" });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 1 });
    const missing = await view.collab.agentEdit().write(
      {
        command: "replace",
        documentId: ALPHA_ID,
        file: "alpha.md",
        find: "Gamma",
        content: "retry",
        tool_use_id: "after-undo",
      },
      { ...context, responseIdentity: { providerResponseId: second, editScopeId: second } },
    );
    expect(missing.status).toBe("not_found");
    expect(missing.result.message).toContain('"Gamma" → "Gild"');
    expect(missing.result.message).toContain('"Gild" → "Bronze"');
    await harness.commit(second);
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
    expect(await view.draftMarkdown(branch.id)).toBe("Alpha Beta.\n\nSilver.\n");
    const entries = await db
      .select()
      .from(schema.documentEdits)
      .where(
        and(eq(schema.documentEdits.responseId, second), eq(schema.documentEdits.kind, "write")),
      );
    expect(entries).toHaveLength(1);
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("Discard of the mixed document's Undo change reactivates its applied part", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
    for (const [find, content] of [
      ["Beta", "Gamma"],
      ["Blue", "Silver"],
    ])
      expect(
        await view.collab.agentEdit().write(
          {
            command: "replace",
            documentId: ALPHA_ID,
            file: "alpha.md",
            find,
            content,
            tool_use_id: find,
          },
          context,
        ),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
    });
    const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    const preview = await view.collab.draftReview.preview(scope);
    if (preview.status !== "active") throw new Error("Missing draft");
    const gamma = preview.operations.find((operation) => operation.afterExcerpt === "Gamma");
    if (!gamma) throw new Error("Missing Gamma change");
    expect(
      await view.collab.draftReview.applyWorkDraftChanges({
        ...scope,
        operationIds: [gamma.operationId],
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
      }),
    ).toMatchObject({ status: "applied" });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const inverse = await view.collab.draftReview.preview(scope);
    if (inverse.status !== "active") throw new Error("Missing inverse");
    expect(inverse.operations).toHaveLength(1);
    expect(
      await view.collab.draftReview.discardWorkDraft({
        ...scope,
        operationIds: [inverse.operations[0].operationId],
        liveRevisionToken: inverse.liveRevisionToken,
        draftRevisionToken: inverse.draftRevisionToken,
      }),
    ).toMatchObject({ status: "discarded" });
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "partial", acceptedParts: 1 });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("typing inside restored text leaves Redo unavailable and does not delete the writer's word", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "",
          tool_use_id: "delete",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
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
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
      skips: [{ before: "Beta", reason: "Stayed as you edited it" }],
    });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "expired", acceptedParts: 0 });
    expect(await view.draftMarkdown(branch.id)).toBe("Alpha Be!ta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("overlapping applied and pending parts undo together in the draft", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
    await view.collab.agentEdit().write(
      {
        command: "replace",
        documentId: ALPHA_ID,
        file: "alpha.md",
        find: "Beta",
        content: "Gamma",
        tool_use_id: "first",
      },
      context,
    );
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
    });
    const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    expect(await view.collab.draftReview.applyWorkDraft(scope)).toMatchObject({
      status: "applied",
    });
    const second = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: second as never,
      turnId: TURN_ID,
      sequence: 2,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    await view.collab.agentEdit().write(
      {
        command: "replace",
        documentId: ALPHA_ID,
        file: "alpha.md",
        find: "Gamma",
        content: "Delta",
        tool_use_id: "overlap",
      },
      { ...context, responseIdentity: { providerResponseId: second, editScopeId: second } },
    );
    await harness.commit(second);
    for (const direction of ["undo", "redo"] as const) {
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction,
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed", acceptedParts: 2 });
      expect(await view.draftMarkdown(draft.draftId)).toBe(
        direction === "undo" ? "Alpha Beta.\n\nBlue.\n" : "Alpha Delta.\n\nBlue.\n",
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    }
    expect(await view.collab.draftReview.applyWorkDraft(scope)).toMatchObject({
      status: "applied",
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Delta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each(["empty", "mixed"])("inverse placement through Apply and %s reset", async (placement) => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
    const second = randomUUID();
    await db.insert(schema.modelResponses).values({
      id: second as never,
      turnId: TURN_ID,
      sequence: 2,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    for (const [find, content, id] of [
      ["Beta", "Gamma", responseId],
      ["Blue", "Silver", second],
    ]) {
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find,
          content,
          tool_use_id: find,
        },
        { ...context, responseIdentity: { providerResponseId: id, editScopeId: id } },
      );
      await harness.commit(id);
    }
    const [draft] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
    });
    const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    if (placement === "mixed") {
      const preview = await view.collab.draftReview.preview(scope);
      if (preview.status !== "active") throw new Error("Missing preview");
      await view.collab.draftReview.applyWorkDraftChanges({
        ...scope,
        operationIds: [preview.operations[0].operationId],
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
      });
    }
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 2 });
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Beta.\n\nBlue.\n");
    if (placement === "empty") {
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, draft.draftId));
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, branch.state);
        doc.clientID = allocateDocumentClient(doc);
        const updates = captureMutationUpdates(doc, () => {
          const p = new Y.XmlElement("paragraph"),
            t = new Y.XmlText();
          t.insert(0, "Extra.");
          p.insert(0, [t]);
          doc.getXmlFragment("prosemirror").insert(2, [p]);
        });
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
    }
    const inversePreview = await view.collab.draftReview.preview(scope);
    if (inversePreview.status !== "active") throw new Error("Missing inverse preview");
    expect(inversePreview.operations).toHaveLength(1);
    await view.collab.draftReview.applyWorkDraftChanges({
      ...scope,
      operationIds: [inversePreview.operations[0].operationId],
      liveRevisionToken: inversePreview.liveRevisionToken,
      draftRevisionToken: inversePreview.draftRevisionToken,
    });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
      placement === "empty" ? "Alpha Beta.\n\nBlue.\n\nExtra.\n" : "Alpha Beta.\n\nBlue.\n",
    );
    const outcome = await view.collab.reverseTurn({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      direction: "redo",
      actor: { type: "user", userId: USER_ID },
    });
    expect(outcome).toMatchObject(
      placement === "mixed"
        ? { status: "partial", acceptedParts: 1 }
        : { status: "expired", acceptedParts: 0 },
    );
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
      placement === "mixed" ? "Alpha Gamma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n\nExtra.\n",
    );
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("failed response leaves only the writer-dependent draft part rollback_pending", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    for (const [find, content] of [
      ["Beta", "Gamma"],
      ["Blue", "Silver"],
    ])
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find,
          content,
          tool_use_id: find,
        },
        context,
      );
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
    });
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
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    const pending = await db
      .select()
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.status, "rollback_pending"));
    expect(pending).toHaveLength(1);
    expect(
      await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.kind, "rollback")),
    ).toHaveLength(1);
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("an unrelated restoration hold leaves applied Undo and Redo in live through Apply", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
    await view.collab.agentEdit().write(
      {
        command: "replace",
        documentId: ALPHA_ID,
        file: "alpha.md",
        find: "Beta",
        content: "Gamma",
        tool_use_id: "applied",
      },
      context,
    );
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list({
      projectId: PROJECT_ID as never,
      workId: WORK_ID,
    });
    const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    await view.collab.draftReview.applyWorkDraft(scope);
    const otherTurn = randomUUID() as typeof TURN_ID,
      otherResponse = randomUUID();
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
    await db
      .insert(schema.turns)
      .values({ ...turn, id: otherTurn, parentTurnId: TURN_ID, position: turn.position + 1 });
    await db.insert(schema.modelResponses).values({
      id: otherResponse as never,
      turnId: otherTurn,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    await view.collab.agentEdit().write(
      {
        command: "replace",
        documentId: ALPHA_ID,
        file: "alpha.md",
        find: "Blue",
        content: "Silver",
        tool_use_id: "unrelated",
      },
      {
        ...context,
        turnId: otherTurn,
        responseIdentity: { providerResponseId: otherResponse, editScopeId: otherResponse },
      },
    );
    await harness.commit(otherResponse);
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: otherTurn,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 1 });
    for (const direction of ["undo", "redo"] as const) {
      const outcome = await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction,
        actor: { type: "user", userId: USER_ID },
      });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe(
        direction === "undo" ? "Alpha Beta.\n\nBlue.\n" : "Alpha Gamma.\n\nBlue.\n",
      );
      expect(outcome).toMatchObject({
        status: "reversed",
        acceptedParts: 1,
        documents: [{ destination: { kind: "live" } }],
      });
    }
    await view.collab.draftReview.applyWorkDraft(scope);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("an already-connected live room sees Undo, Redo and immediate rollback without a repairing read", async () => {
  const { harness, view, responseId, context } = await fixture();
  const peer = new Y.Doc({ gc: false });
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
    const room = view.hocuspocus.documents.get(ALPHA_ID);
    if (!room) throw new Error("Room was not connected");
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(room));
    room.on("update", (update: Uint8Array) => Y.applyUpdate(peer, update));
    const prose = () =>
      peer
        .getXmlFragment("prosemirror")
        .toArray()
        .map((node) =>
          node instanceof Y.XmlElement
            ? node
                .toArray()
                .map((child) => (child instanceof Y.XmlText ? child.toString() : ""))
                .join("")
            : "",
        )
        .join("\n\n");
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "immediate",
        },
        immediate,
      ),
    ).toMatchObject({ status: "success", phase: "committed" });
    // Reading the fixture creates an empty default draft. Retire it before observing the no-draft room.
    await db
      .update(schema.documentBranches)
      .set({ status: "closed" })
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
    expect(await view.branchStore.listActiveWorkDraftBranchIds(ALPHA_ID)).toEqual([]);
    expect(prose()).toBe("Alpha Gamma.\n\nBlue.");
    for (const direction of ["undo", "redo"] as const) {
      const broadcasts = view.hocuspocus.broadcasts.length;
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction,
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed", acceptedParts: 1 });
      expect(view.hocuspocus.broadcasts.length).toBeGreaterThan(broadcasts);
      expect(prose()).toBe(direction === "undo" ? "Alpha Beta.\n\nBlue." : "Alpha Gamma.\n\nBlue.");
    }
    const broadcasts = view.hocuspocus.broadcasts.length;
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(view.hocuspocus.broadcasts.length).toBeGreaterThan(broadcasts);
    expect(prose()).toBe("Alpha Beta.\n\nBlue.");
  } finally {
    peer.destroy();
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "undo",
  "rollback",
  "redo",
] as const)("%s through the receipt service signals and reopens the original settled trail", async (action) => {
  const { harness, view, responseId, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "trail-inverse",
        },
        context,
      ),
    ).toMatchObject({ status: "success", phase: "staged" });
    await harness.commit(responseId);
    if (action === "redo") {
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed", acceptedParts: 1, skips: [] });
    }
    await db.update(schema.turns).set({ status: "complete" }).where(eq(schema.turns.id, TURN_ID));
    const writer = createDrizzleChangeTrailAggregateWriter(db);
    await writer.reconcileTerminalOwners();
    await writer.reconcileTerminalOwners();
    const [settled] = await db
      .select()
      .from(schema.changeTrailShells)
      .where(eq(schema.changeTrailShells.turnId, TURN_ID));
    expect(settled.state).toBe("settled");
    expect(
      await db
        .select()
        .from(schema.changeTrailDirtyLog)
        .where(eq(schema.changeTrailDirtyLog.turnId, TURN_ID)),
    ).toEqual([]);

    if (action !== "rollback") {
      expect(
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: action,
          actor: { type: "user", userId: USER_ID },
        }),
      ).toMatchObject({ status: "reversed", acceptedParts: 1, skips: [] });
    } else {
      await harness.rollbackResponse(responseId);
    }
    const [inverse] = await db
      .select()
      .from(schema.documentEdits)
      .where(eq(schema.documentEdits.kind, action));
    expect(inverse).toMatchObject({ threadId: null, turnId: null });
    expect(
      await db
        .select()
        .from(schema.changeTrailDirtyLog)
        .where(eq(schema.changeTrailDirtyLog.turnId, TURN_ID)),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ threadId: THREAD_ID })]));

    // A cold reconciler discovers only durable signals, not service-local owner enrollment.
    await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
    const [reopened] = await db
      .select()
      .from(schema.changeTrailShells)
      .where(eq(schema.changeTrailShells.turnId, TURN_ID));
    expect(reopened).toMatchObject({ state: "settling", settledAt: null });
    expect(reopened.version).toBeGreaterThan(settled.version);
    expect(
      await db
        .select()
        .from(schema.changeTrailDeliveryOutbox)
        .where(eq(schema.changeTrailDeliveryOutbox.trailId, settled.id)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: reopened.version, eventKind: "updated" }),
      ]),
    );
    if (action === "redo") {
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(
          and(
            eq(schema.documentBranches.documentId, ALPHA_ID),
            eq(schema.documentBranches.kind, "work_draft"),
          ),
        );
      expect(await view.draftMarkdown(branch.id)).toBe("Alpha Gamma.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      expect(
        await view.collab.draftReview.applyWorkDraft({
          projectId: PROJECT_ID as never,
          workId: WORK_ID,
          documentId: ALPHA_ID,
          draftId: branch.id,
          userId: USER_ID as never,
        }),
      ).toMatchObject({ status: "applied" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
      expect(await db.select().from(schema.pushLineage)).not.toEqual([]);
      await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
      await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
      const [resettled] = await db
        .select()
        .from(schema.changeTrailShells)
        .where(eq(schema.changeTrailShells.turnId, TURN_ID));
      expect(resettled).toMatchObject({
        state: "settled",
        settledAt: expect.any(Date),
        changeCount: 1,
        documentCount: 1,
      });
      expect(resettled.version).toBeGreaterThan(reopened.version);
      expect(
        await db
          .select()
          .from(schema.changeTrailDeliveryOutbox)
          .where(eq(schema.changeTrailDeliveryOutbox.trailId, settled.id)),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            version: resettled.version,
            eventKind: "settled",
            documents: [expect.objectContaining({ documentId: ALPHA_ID })],
          }),
        ]),
      );
    }
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

/** The model surface runs on the same durable store as the writer's card. */
describe("model document stack", () => {
  it.each([
    "stepwise",
    "count",
  ] as const)("overlapping replacements compose %s undo and redo", async (schedule) => {
    const { harness, view, context, responseId, target } = await fixture();
    try {
      for (const [index, [find, content]] of [
        ["Beta", "Gold"],
        ["Gold", "Silver"],
        ["Silver", "Azure"],
      ].entries())
        expect(
          await view.collab.agentEdit().write(
            {
              command: "replace",
              documentId: ALPHA_ID,
              file: "alpha.md",
              find,
              content,
              tool_use_id: `entry-${index}`,
            },
            context,
          ),
        ).toMatchObject({ status: "success", writeId: `w${index + 1}` });
      await harness.commit(responseId);
      const [draft] = await view.collab.draftReview.list(target);
      let call = 0;
      const write = async (command: "undo" | "redo", count?: number) =>
        view.collab.agentEdit().write(
          {
            command,
            documentId: ALPHA_ID,
            file: "alpha.md",
            ...(count ? { count } : {}),
            tool_use_id: `inverse-${++call}`,
          },
          context,
        );
      expect(await write("undo", 4)).toMatchObject({ status: "nothing_to_undo" });
      expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Azure.\n\nBlue.\n");
      if (schedule === "count") {
        expect(await write("undo", 3)).toMatchObject({ status: "success" });
        expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await write("redo")).toMatchObject({ status: "success" });
      } else {
        for (const text of ["Silver", "Gold", "Beta"]) {
          expect(await write("undo")).toMatchObject({ status: "success" });
          expect(await view.draftMarkdown(draft.draftId)).toBe(`Alpha ${text}.\n\nBlue.\n`);
        }
        expect(await write("redo")).toMatchObject({
          status: "success",
          result: { message: "redone: w1" },
        });
        expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Gold.\n\nBlue.\n");
        expect(await write("redo", 2)).toMatchObject({ status: "success" });
      }
      expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Azure.\n\nBlue.\n");
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
  it.each([
    "pending",
    "applied",
    "discarded",
    "user undo",
  ] as const)("model refuses user-acted %s tops and reverts eligible parts", async (state) => {
    const { harness, view, context, responseId, target } = await fixture();
    try {
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "entry",
        },
        context,
      );
      await harness.commit(responseId);
      const [draft] = await view.collab.draftReview.list(target);
      const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
      if (state === "applied") await view.collab.draftReview.applyWorkDraft(scope);
      if (state === "discarded") await view.collab.draftReview.discardWorkDraft(scope);
      if (state === "user undo")
        await view.collab.reverseTurn({
          threadId: THREAD_ID,
          turnId: TURN_ID,
          direction: "undo",
          actor: { type: "user", userId: USER_ID },
        });
      const edits = await view.collab
        .agentEdit()
        .read({ documentId: ALPHA_ID, file: "alpha.md", format: "edits" }, context);
      expect(edits).toMatchObject({ status: "success" });
      expect(edits.result.message).toContain(state === "user undo" ? "undone by the user" : state);
      const command = state === "user undo" ? "redo" : "undo";
      const undone = await view.collab
        .agentEdit()
        .write(
          { command, documentId: ALPHA_ID, file: "alpha.md", tool_use_id: "model-inverse" },
          context,
        );
      expect(undone.status).toBe(
        state === "pending"
          ? "success"
          : state === "user undo"
            ? "cant_redo_users_undo"
            : `cant_undo_${state}`,
      );
      if (state === "applied") {
        expect(
          await view.collab.agentEdit().write(
            {
              command: "revert",
              documentId: ALPHA_ID,
              file: "alpha.md",
              edit: "w1",
              tool_use_id: "revert",
            },
            context,
          ),
        ).toMatchObject({ status: "success", writeId: "w2" });
        expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Beta.\n\nBlue.\n");
        expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
      }
    } finally {
      harness.cancelScheduledPulls();
      harness.destroyWarmState();
    }
  });
});

it.each([
  "undo",
  "redo",
] as const)("model %s refuses changed and elsewhere without touching content", async (direction) => {
  const { harness, view, context, responseId, target } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const command = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list(target);
    if (direction === "redo")
      expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
        status: "success",
      });
    const liveContext = {
      ...context,
      responseIdentity: undefined,
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
    };
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(await core.write({ ...command, command: direction }, liveContext)).toMatchObject({
      status: `cant_${direction}_elsewhere`,
    });
    await core.read({ ...command, format: "edits" }, context);
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
    const expected = direction === "undo" ? "Alpha Ga!mma.\n\nBlue.\n" : "Alpha Be!ta.\n\nBlue.\n";
    expect(await core.write({ ...command, command: direction }, context)).toMatchObject({
      status: `cant_${direction}_changed`,
    });
    expect(await core.write({ ...command, command: "revert", edit: "w1" }, context)).toMatchObject({
      status: "nothing_to_revert",
    });
    expect(await view.draftMarkdown(draft.draftId)).toBe(expected);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "applied",
  "discarded",
] as const)("model cannot redo an undo the user %s", async (state) => {
  const { harness, view, context, responseId, target } = await fixture();
  try {
    const core = view.collab.agentEdit(),
      command = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.write({ ...command, command: "replace", find: "Beta", content: "Gamma" }, context);
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list(target);
    expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
      status: "success",
    });
    const scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    if (state === "applied") await view.collab.draftReview.applyWorkDraft(scope);
    else await view.collab.draftReview.discardWorkDraft(scope);
    expect(await core.write({ ...command, command: "redo" }, context)).toMatchObject({
      status: `cant_redo_${state}`,
    });
    const edits = await core.read({ ...command, format: "edits" }, context);
    expect(edits.result.message).not.toMatch(/ {2}redo(?:\n|$)/);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("model edit pages decode immutable parts and a new revert clears redo in the current destination", async () => {
  const { harness, view, context, responseId, target } = await fixture();
  try {
    const core = view.collab.agentEdit(),
      command = { documentId: ALPHA_ID, file: "alpha.md" };
    let previous = "Beta";
    for (let n = 1; n <= 25; n++) {
      expect(
        await core.write(
          { ...command, command: "replace", find: previous, content: `Text${n}` },
          context,
        ),
      ).toMatchObject({ status: "success", writeId: `w${n}` });
      previous = `Text${n}`;
      if (n === 1) {
        await harness.commit(responseId);
        const [first] = await view.collab.draftReview.list(target);
        await view.collab.draftReview.applyWorkDraft({
          ...target,
          draftId: first.draftId,
          userId: USER_ID as never,
        });
        context.responseIdentity = { providerResponseId: responseId, editScopeId: randomUUID() };
      }
    }
    await view.collab.finalizeResponseCommit(context.responseIdentity, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    const page = await core.read({ ...command, format: "edits" }, context);
    expect(page.result.message?.split("\n").filter((line) => /^w\d+ {2}/.test(line))).toHaveLength(
      20,
    );
    expect(page.result.message).toContain('w25  this turn  pending  "Text24" → "Text25"  undo');
    expect(page.result.message).toContain("more: before w6");
    const second = await core.read({ ...command, format: "edits", before: "w6" }, context);
    expect(
      second.result.message?.split("\n").filter((line) => /^w\d+ {2}/.test(line)),
    ).toHaveLength(5);
    expect(second.result.message).toContain('w1  this turn  applied  "Beta" → "Text1"');
    expect(await core.write({ ...command, command: "undo" }, context)).toMatchObject({
      status: "success",
    });
    expect(await core.write({ ...command, command: "revert", edit: "w24" }, context)).toMatchObject(
      { status: "success", writeId: "w27" },
    );
    expect(await core.write({ ...command, command: "redo" }, context)).toMatchObject({
      status: "nothing_to_redo",
    });
    const [draft] = await view.collab.draftReview.list(target);
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Text23.\n\nBlue.\n");
    const liveContext = {
      ...context,
      responseIdentity: undefined,
      grant: testFileGrant({ kind: "live" }, ALPHA_ID),
    };
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(
      await core.write({ ...command, command: "revert", edit: "w23" }, liveContext),
    ).toMatchObject({ status: "nothing_to_revert" });
    await core.read({ ...command, format: "edits" }, context);
    await view.collab.draftReview.applyWorkDraft({
      ...target,
      draftId: draft.draftId,
      userId: USER_ID as never,
    });
    await core.read({ ...command, format: "edits" }, liveContext);
    expect(
      await core.write({ ...command, command: "revert", edit: "w23" }, liveContext),
    ).toMatchObject({ status: "success", writeId: "w28" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Text22.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "live",
  "draft",
] as const)("failed edit scope rolls back durable model inverses in %s without losing provider authorship", async (destination) => {
  const { harness, view, context, responseId } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    const initial =
      destination === "live"
        ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
        : context;
    await core.read(address, initial);
    expect(
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, initial),
    ).toMatchObject({ status: "success", writeId: "w1" });
    await harness.commit(responseId);
    const responseIdentity = { providerResponseId: responseId, editScopeId: randomUUID() };
    const inverseContext = { ...initial, responseIdentity };
    for (const command of ["undo", "redo"] as const)
      expect(await core.write({ ...address, command }, inverseContext)).toMatchObject({
        status: "success",
      });
    expect(
      await core.write({ ...address, command: "revert", edit: "w1" }, inverseContext),
    ).toMatchObject({ status: "success", writeId: "w4" });
    const [branch] = await db
      .select()
      .from(schema.documentBranches)
      .where(
        and(
          eq(schema.documentBranches.documentId, ALPHA_ID),
          eq(schema.documentBranches.workId, WORK_ID),
          eq(schema.documentBranches.kind, "work_draft"),
        ),
      );
    const prose = () =>
      destination === "live" ? harness.liveMarkdown(ALPHA_ID) : view.draftMarkdown(branch.id);
    expect(await prose()).toBe("Alpha Beta.\n\nBlue.\n");
    await view.collab.finalizeResponseRollback(responseIdentity, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(await prose()).toBe("Alpha Gamma.\n\nBlue.\n");
    await view.collab.finalizeResponseRollback(responseIdentity, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(await prose()).toBe("Alpha Gamma.\n\nBlue.\n");
    const rows = await db
      .select()
      .from(schema.documentEdits)
      .where(eq(schema.documentEdits.editScopeId, responseIdentity.editScopeId));
    expect(rows.filter((row) => row.actor === "agent").map((row) => row.responseId)).toEqual([
      responseId,
      responseId,
      responseId,
    ]);
    expect(rows.filter((row) => row.kind === "rollback")).toHaveLength(0);
    const edits = await core.read({ ...address, format: "edits" }, initial);
    expect(edits.result.message).toMatch(/w4.*rolled back/);
    expect(edits.result.message).toMatch(/w1.*undo(?:\n|$)/);
    expect(await core.write({ ...address, command: "redo" }, initial)).toMatchObject({
      status: "nothing_to_redo",
    });
    expect(await db.select().from(schema.modelResponses)).toHaveLength(1);
    if (destination === "draft") {
      const authored = await db
        .select()
        .from(schema.branchWriteJournal)
        .where(
          and(
            eq(schema.branchWriteJournal.branchId, branch.id),
            eq(schema.branchWriteJournal.source, "agent"),
          ),
        );
      const metadata = authored.map(
        (row) => row.updateMeta as { authoringResponseId?: string; editScopeId?: string },
      );
      expect(metadata.map((meta) => meta.authoringResponseId)).toEqual([
        responseId,
        responseId,
        responseId,
        responseId,
      ]);
      expect(
        metadata.filter((meta) => meta.editScopeId === responseIdentity.editScopeId),
      ).toHaveLength(3);
    }
    if (destination === "live") {
      const journal = await db
        .select()
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.documentId, ALPHA_ID));
      expect(
        journal
          .filter((row) => row.authoringResponseId !== null)
          .every((row) => row.authoringResponseId === responseId),
      ).toBe(true);
    }
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "changed",
  "partly applied",
] as const)("a multipart %s top blocks undo but targeted revert preserves skipped content", async (state) => {
  const { harness, view, context, responseId, target } = await fixture();
  try {
    const core = view.collab.agentEdit(),
      address = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.read(address, context);
    expect(
      await core.write(
        { ...address, command: "replace", in: [1, 2], content: "Alpha Gamma.\n\nSilver." },
        context,
      ),
    ).toMatchObject({ status: "success", writeId: "w1" });
    await harness.commit(responseId);
    const [draft] = await view.collab.draftReview.list(target),
      scope = { ...target, draftId: draft.draftId, userId: USER_ID as never };
    if (state === "partly applied") {
      const preview = await view.collab.draftReview.preview(scope);
      if (preview.status !== "active") throw new Error("Missing multipart draft");
      await view.collab.draftReview.applyWorkDraftChanges({
        ...scope,
        operationIds: [preview.operations[0].operationId],
        liveRevisionToken: preview.liveRevisionToken,
        draftRevisionToken: preview.draftRevisionToken,
      });
    } else {
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
    }
    const before = state === "changed" ? "Alpha Ga!mma.\n\nSilver.\n" : "Alpha Gamma.\n\nSilver.\n";
    const edits = await core.read({ ...address, format: "edits" }, context);
    expect(edits.result.message).toContain(
      state === "changed" ? "changed" : "partly applied (1 of 2)",
    );
    if (state === "changed") expect(edits.result.message).toContain("revert 1 of 2");
    expect(await core.write({ ...address, command: "undo" }, context)).toMatchObject({
      status: state === "changed" ? "cant_undo_changed" : "cant_undo_applied",
    });
    expect(await view.draftMarkdown(draft.draftId)).toBe(before);
    expect(await core.write({ ...address, command: "revert", edit: "w1" }, context)).toMatchObject({
      status: "success",
      writeId: "w2",
    });
    expect(await view.draftMarkdown(draft.draftId)).toBe(
      state === "changed" ? "Alpha Ga!mma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n",
    );
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it("model inverse receipts echo only changed blocks and their immediate context", async () => {
  const { harness, view, context, responseId } = await fixture();
  try {
    await harness.seedWriterDocument(
      ["Alpha Beta.", "Blue.", ...Array.from({ length: 10 }, (_, n) => `Far ${n}.`)].join("\n\n"),
      responseId,
    );
    const core = view.collab.agentEdit(),
      address = { documentId: ALPHA_ID, file: "alpha.md" };
    await core.read(address, context);
    expect(
      await core.write({ ...address, command: "replace", find: "Beta", content: "Gamma" }, context),
    ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    for (const command of ["undo", "redo"] as const) {
      const result = await core.write({ ...address, command }, context);
      expect(result.status).toBe("success");
      expect(JSON.stringify(result.result)).toContain(
        command === "undo" ? "Alpha Beta." : "Alpha Gamma.",
      );
      expect(JSON.stringify(result.result)).not.toContain("Far 9.");
    }
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
