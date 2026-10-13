/** Durable inverse publication to live rooms and review trails. */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import { testFileGrant } from "../../test-support/file-grants.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
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

import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
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
