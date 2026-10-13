/** Placement transitions and root-identity holds. */
import { randomUUID } from "node:crypto";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "./test-support/change-trail-postgres-harness.js";

import { reviewDriver } from "./test-support/draft-review-requests.js";
import { draftBranchId, inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
it.each([
  "applied",
  "live",
  "redo",
] as const)("another draft holds %s text, then release leaves Redo first with an active part", async (origin) => {
  const { harness, view, responseId, context, target } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
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
      expect(await review.applyItem(ALPHA_ID)).toMatchObject({ status: "applied" });
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
    const holdingReview = reviewDriver(view.collab.draftReview, { workId: otherWork as never });
    const [work] = await db.select().from(schema.works).where(eq(schema.works.id, WORK_ID));
    const [thread] = await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID));
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
    await db
      .insert(schema.works)
      .values({ ...work, id: otherWork as never, name: "Holding draft", slug: "holding" });
    await db.insert(schema.drafts).values({
      projectId: PROJECT_ID,
      originWorkId: otherWork as never,
      createdBy: USER_ID,
    });
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
        await view.collab.agentEdit().write({ ...address, command: "redo", count: 2 }, redoContext),
      ).toMatchObject({ status: "cant_redo_held" });
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Beta.\n\nBlue.\n");
      const edits = await view.collab
        .agentEdit()
        .read({ ...address, format: "edits" }, redoContext);
      expect(edits.result.message).not.toMatch(/ {2}redo(?:\n|$)/);
      await holdingReview.discardItem(ALPHA_ID);
      expect(
        await view.collab.agentEdit().write({ ...address, command: "redo", count: 2 }, redoContext),
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
    expect(await holdingReview.discardItem(ALPHA_ID)).toMatchObject({ status: "discarded" });
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
    expect(missing.result.message).toContain("an inverse removed the text it edited");
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

it("overlapping applied and pending parts undo together in the draft", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
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
    const branchId = await draftBranchId(db, ALPHA_ID);
    expect(await review.applyItem(ALPHA_ID)).toMatchObject({ status: "applied" });
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
      expect(await view.draftMarkdown(branchId)).toBe(
        direction === "undo" ? "Alpha Beta.\n\nBlue.\n" : "Alpha Delta.\n\nBlue.\n",
      );
      expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
    }
    expect(await review.applyItem(ALPHA_ID)).toMatchObject({ status: "applied" });
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Delta.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each(["empty", "mixed"])("inverse placement through Apply and %s reset", async (placement) => {
  const { harness, view, responseId, context, target } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
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
    const branchId = await draftBranchId(db, ALPHA_ID);
    if (placement === "mixed") {
      const preview = await review.activePreview(ALPHA_ID);
      await review.applyChanges(ALPHA_ID, preview, [preview.operations[0].operationId]);
    }
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 2 });
    expect(await view.draftMarkdown(branchId)).toBe("Alpha Beta.\n\nBlue.\n");
    if (placement === "empty") {
      const [branch] = await db
        .select()
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, branchId));
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
    const inversePreview = await review.activePreview(ALPHA_ID);
    expect(inversePreview.operations).toHaveLength(1);
    await review.applyChanges(ALPHA_ID, inversePreview, [inversePreview.operations[0].operationId]);
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

it("an unrelated restoration hold leaves applied Undo and Redo in live through Apply", async () => {
  const { harness, view, responseId, context, target } = await fixture();
  const review = reviewDriver(view.collab.draftReview);
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
    await review.applyItem(ALPHA_ID);
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
    await review.applyItem(ALPHA_ID);
    expect(await harness.liveMarkdown(ALPHA_ID)).toBe("Alpha Gamma.\n\nBlue.\n");
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
