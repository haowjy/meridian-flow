/** Edit-scope rollback, terminal targets and restored availability. */
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
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
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
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Gamma.\n\nBlue.\n");
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
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, await draftContent(db, documentDraft.id));
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
      const updates = captureMutationUpdates(doc, () => text.insert(8, "!"));
      await view.draftCoordinator.commitWriterUpdate({
        draftId: documentDraft.id,
        updateData: Y.mergeUpdates(updates),
        actorUserId: USER_ID,
        roomDocument: doc,
      });
    } finally {
      doc.destroy();
    }
    const revision = async () =>
      (
        await db
          .select({ revision: schema.documentDrafts.revision })
          .from(schema.documentDrafts)
          .where(eq(schema.documentDrafts.id, documentDraft.id))
      )[0]?.revision ?? -1;
    const beforeRollback = await revision();
    await view.collab.finalizeResponseRollback(
      { providerResponseId: responseId, editScopeId: responseId },
      {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      },
    );
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    // The draft's text stays: its revision moves for the active → rollback_pending flip (§2.5).
    expect(await revision()).toBeGreaterThan(beforeRollback);
    const pending = await db
      .select()
      .from(schema.draftWriteJournal)
      .where(eq(schema.draftWriteJournal.status, "rollback_pending"));
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
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Ga!mma.\n\nBlue.\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "view_change",
    });
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
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    const prose = () =>
      destination === "live"
        ? harness.liveMarkdown(ALPHA_ID)
        : view.draftMarkdown(documentDraft.id);
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
        .from(schema.draftWriteJournal)
        .where(
          and(
            eq(schema.draftWriteJournal.draftId, documentDraft.id),
            eq(schema.draftWriteJournal.source, "agent"),
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

it.each(
  (["live", "draft"] as const).flatMap((destination) =>
    (["undo", "redo", "revert"] as const).map((command) => ({ destination, command })),
  ),
)("failed $command in a separate scope restores $destination availability on retry", async ({
  destination,
  command,
}) => {
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
    const saved = {
      ...initial,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
    };
    if (command === "redo")
      expect(await core.write({ ...address, command: "undo" }, saved)).toMatchObject({
        status: "success",
        result: { message: "undone: w1" },
      });
    const failed = {
      ...initial,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
    };
    expect(
      await core.write(
        command === "revert" ? { ...address, command, edit: "w1" } : { ...address, command },
        failed,
      ),
    ).toMatchObject({ status: "success" });
    const draft =
      destination === "draft"
        ? (
            await db
              .select({ draftId: schema.documentDrafts.id })
              .from(schema.documentDrafts)
              .where(
                and(
                  eq(schema.documentDrafts.documentId, ALPHA_ID),
                  eq(schema.documentDrafts.kind, "work_draft"),
                ),
              )
          )[0]
        : null;
    const text = () => (draft ? view.draftMarkdown(draft.draftId) : harness.liveMarkdown(ALPHA_ID));
    expect(await text()).toBe(
      command === "redo" ? "Alpha Gamma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n",
    );
    for (let retry = 0; retry < 2; retry++) {
      await view.collab.finalizeResponseRollback(failed.responseIdentity, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      expect(await text()).toBe(
        command === "redo" ? "Alpha Beta.\n\nBlue.\n" : "Alpha Gamma.\n\nBlue.\n",
      );
      const edits = await core.read({ ...address, format: "edits" }, saved);
      const original = edits.result.message?.split("\n").find((line) => line.startsWith("w1  "));
      expect(original).toMatch(
        command === "redo" ? /undone.* {2}redo$/ : /(?:live|pending).* {2}undo$/,
      );
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
        state: command === "redo" ? "live-reversed" : "live-active",
        control: command === "redo" ? "redo" : "undo",
      });
    }
    const retry = {
      ...saved,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
    };
    expect(
      await core.write({ ...address, command: command === "redo" ? "redo" : "undo" }, retry),
    ).toMatchObject({
      status: "success",
      result: { message: command === "redo" ? "redone: w1" : "undone: w1" },
    });
    expect(await text()).toBe(
      command === "redo" ? "Alpha Gamma.\n\nBlue.\n" : "Alpha Beta.\n\nBlue.\n",
    );
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
