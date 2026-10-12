/** Exact durable content through card inverses, placements and response failures. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
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
    responseId,
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }),
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
        expect(outcome).toMatchObject({ status: "reversed", acceptedParts: 2, skips: [] });
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

it("another draft's hold names one skip, then release leaves Redo first with an active part", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  try {
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
          context,
        ),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
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
      responseId: otherResponse,
      grant: testFileGrant({ kind: "draft", workId: otherWork, workSlug: "holding" }),
    };
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Gamma",
          content: "Delta",
          tool_use_id: "held",
        },
        otherContext,
      ),
    ).toMatchObject({ status: "success" });
    await view.collab.finalizeResponseCommit(otherResponse, {
      threadId: otherThread as never,
      turnId: otherTurn as never,
    });
    expect(
      await view.collab.reverseTurn({
        threadId: otherThread as never,
        turnId: otherTurn as never,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
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
        { ...context, responseId: second },
      ),
    ).toMatchObject({ status: "success" });
    await harness.commit(second);
    await view.collab.finalizeResponseRollback(second, { threadId: THREAD_ID, turnId: TURN_ID });
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
    await view.collab.finalizeResponseRollback(second, { threadId: THREAD_ID, turnId: TURN_ID });
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
          { ...context, responseId: second },
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
      { ...context, responseId: second },
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
      { ...context, responseId: second },
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
        { ...context, responseId: id },
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
    await view.collab.finalizeResponseRollback(responseId, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    const pending = await db
      .select()
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.status, "rollback_pending"));
    expect(pending).toHaveLength(1);
    expect(
      await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.kind, "rollback")),
    ).toHaveLength(1);
    await view.collab.finalizeResponseRollback(responseId, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(await view.draftMarkdown(draft.draftId)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
