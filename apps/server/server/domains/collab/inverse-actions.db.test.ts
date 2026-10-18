/** Shared effective-action history across card and model selectors. */
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

it.each([
  "live",
  "draft",
] as const)("partial writer Undo leaves the changed newest entry as the %s model blocker", async (destination) => {
  const { harness, view, context, responseId } = await fixture();
  try {
    await harness.seedWriterDocument("red\n\nblue\n\nblack", responseId);
    const core = view.collab.agentEdit();
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    const initial =
      destination === "live"
        ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
        : context;
    await core.read(address, initial);
    expect(
      await core.write({ ...address, command: "replace", find: "red", content: "gold" }, initial),
    ).toMatchObject({ status: "success", writeId: "w1" });
    await harness.commit(responseId);
    const currentTurn = randomUUID() as typeof TURN_ID;
    const currentResponse = randomUUID();
    const [turn] = await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID));
    await db
      .insert(schema.turns)
      .values({ ...turn, id: currentTurn, parentTurnId: TURN_ID, position: turn.position + 1 });
    await db.insert(schema.modelResponses).values({
      id: currentResponse as never,
      turnId: currentTurn,
      sequence: 1,
      provider: "mock",
      model: "mock",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    const current = {
      ...initial,
      turnId: currentTurn,
      responseIdentity: { providerResponseId: currentResponse, editScopeId: currentResponse },
    };
    await core.read(address, current);
    expect(
      await core.write(
        { ...address, command: "replace", in: [2, 3], content: "green\n\nwhite" },
        current,
      ),
    ).toMatchObject({ status: "success", writeId: "w2" });
    await view.collab.finalizeResponseCommit(current.responseIdentity, {
      threadId: THREAD_ID,
      turnId: currentTurn,
    });
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
    const change = (doc: Y.Doc) => {
      doc.clientID = allocateDocumentClient(doc);
      const text = (doc.getXmlFragment("prosemirror").get(1) as Y.XmlElement).get(0) as Y.XmlText;
      return Y.mergeUpdates(
        captureMutationUpdates(doc, () => {
          text.delete(0, text.length);
          text.insert(0, "pink");
        }),
      );
    };
    if (draft) {
      const [documentDraft] = await db
        .select()
        .from(schema.documentDrafts)
        .where(eq(schema.documentDrafts.id, draft.draftId));
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, await draftContent(db, documentDraft.id));
        await view.draftCoordinator.commitWriterUpdate({
          draftId: documentDraft.id,
          expectedGeneration: documentDraft.generation,
          updateData: change(doc),
          actorUserId: USER_ID,
          roomDocument: doc,
        });
      } finally {
        doc.destroy();
      }
    } else {
      await view.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
        await view.persistence.journal.append(ALPHA_ID, change(doc), {
          origin: `human:${USER_ID}`,
          seq: 0,
        });
      });
    }
    const text = () => (draft ? view.draftMarkdown(draft.draftId) : harness.liveMarkdown(ALPHA_ID));
    expect(await text()).toBe("gold\n\npink\n\nwhite\n");
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: currentTurn,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "partial", acceptedParts: 1 });
    expect(await text()).toBe("gold\n\npink\n\nblack\n");
    const edits = await core.read({ ...address, format: "edits" }, current);
    expect(edits.result.message).toMatch(/w2 {2}this turn {2}changed.*undo: no \(changed\)/);
    expect(edits.result.message).not.toContain("undone by the user");
    expect(await core.write({ ...address, command: "undo" }, current)).toMatchObject({
      status: "cant_undo_changed",
      result: { message: expect.stringContaining("w2") },
    });
    expect(await text()).toBe("gold\n\npink\n\nblack\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, currentTurn)).toMatchObject({
      state: "live-reversed",
      control: "redo",
    });
    expect(await core.write({ ...address, command: "redo" }, current)).toMatchObject({
      status: "cant_redo_users_undo",
      result: { message: expect.stringContaining("w2") },
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});

it.each([
  "live",
  "draft",
] as const)("a rolled-back newer Undo does not mask the older effective action in %s", async (destination) => {
  const { harness, view, context, responseId } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    const initial =
      destination === "live"
        ? { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) }
        : context;
    await core.read(address, initial);
    for (const [find, content] of [
      ["Beta", "Gamma"],
      ["Blue", "Silver"],
    ])
      expect(
        await core.write({ ...address, command: "replace", find, content }, initial),
      ).toMatchObject({ status: "success" });
    await harness.commit(responseId);
    const saved = {
      ...initial,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
    };
    expect(await core.write({ ...address, command: "undo" }, saved)).toMatchObject({
      status: "success",
      result: { message: "undone: w2" },
    });
    const failed = {
      ...initial,
      responseIdentity: { providerResponseId: responseId, editScopeId: randomUUID() },
    };
    expect(await core.write({ ...address, command: "undo" }, failed)).toMatchObject({
      status: "success",
      result: { message: "undone: w1" },
    });
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
    expect(await text()).toBe("Alpha Beta.\n\nBlue.\n");
    for (let retry = 0; retry < 2; retry++) {
      await view.collab.finalizeResponseRollback(failed.responseIdentity, {
        threadId: THREAD_ID,
        turnId: TURN_ID,
      });
      expect(await text()).toBe("Alpha Gamma.\n\nBlue.\n");
      const edits = await core.read({ ...address, format: "edits" }, saved);
      expect(edits.result.message).toMatch(/w2 {2}this turn {2}undone.* {2}redo(?:\n|$)/);
      expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
        state: "live-reversed",
        control: "redo",
        skips: [],
      });
    }
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        direction: "redo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 1 });
    expect(await text()).toBe("Alpha Gamma.\n\nSilver.\n");
    expect(await core.write({ ...address, command: "redo" }, saved)).toMatchObject({
      status: "nothing_to_redo",
    });
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
  } finally {
    harness.cancelScheduledPulls();
    harness.destroyWarmState();
  }
});
