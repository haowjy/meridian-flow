/**
 * Shared effective-action history across card and model selectors.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - strict newest-first model history alongside user-owned Undo and Redo (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
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
} from "./test-support/collab-postgres-harness.js";
import { draftContent } from "./test-support/draft-store-seam.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it.each([
  "live",
  "draft",
] as const)("Undo after the writer replaced the model's text restores the original beside the writer's and Redo leaves it (%s)", async (destination) => {
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
    ).toMatchObject({ status: "success", writeId: "e1" });
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
      responseIdentity: { modelResponseId: currentResponse },
    };
    await core.read(address, current);
    expect(
      await core.write(
        { ...address, command: "replace", in: [2, 3], content: "green\n\nwhite" },
        current,
      ),
    ).toMatchObject({ status: "success", writeId: "e2" });
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
    expect(await core.write({ ...address, command: "undo" }, current)).toMatchObject({
      status: "success",
      result: { message: "undone: e2" },
    });
    expect(await text()).toBe("gold\n\nbluepink\n\nblack\n");
    expect(await core.write({ ...address, command: "redo" }, current)).toMatchObject({
      status: "success",
    });
    expect(await text()).toBe("gold\n\npink\n\nwhite\n");
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: currentTurn,
        direction: "undo",
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed", acceptedParts: 2 });
    expect(await text()).toBe("gold\n\nbluepink\n\nblack\n");
    expect(await view.collab.getTurnReceiptChip(THREAD_ID, currentTurn)).toMatchObject({
      state: "live-reversed",
      control: "redo",
    });
  } finally {
    await harness.dispose();
  }
});
