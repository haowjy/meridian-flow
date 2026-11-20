/**
 * A card keeps its Undo for a drafted AI edit after Live splits a paragraph and the pull runs:
 * the card reads the edit's change from text, so no rewrite of Live's ids takes it away.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - a drafted edit's state is read from its recorded `delta` against the draft's text, never from Yjs item ids
 * - the card's Undo of a drafted change is an append that takes out the changes that still stand
 */
import { readBlocks, writeBlocks } from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { afterAll, beforeEach, expect, it } from "vitest";
import * as Y from "yjs";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/collab-postgres-harness.js";
import { stageDraft } from "./test-support/document-edit-receipt-fixture.js";

const db = createTestDatabase();
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));
const pm = buildDocumentSchema();

it("card keeps Undo after Live splits a paragraph and the pull ran", async () => {
  const harness = createHarness(db);
  try {
    const { fixture, draftId } = await stageDraft(db, harness, "red\n\nblue\n\ngreen", "replace", [
      ["red", "gold"],
    ]);
    await fixture.liveCoordinator.withDocument(ALPHA_ID, async (doc) => {
      const fragment = doc.getXmlFragment("prosemirror");
      const before = Y.encodeStateVector(doc);
      const blocks = readBlocks(fragment, pm);
      const green = blocks[2];
      doc.transact(() =>
        writeBlocks(fragment, pm, [
          ...blocks.slice(0, 2),
          pm.nodes.paragraph.create({ id: green.attrs.id }, pm.text("gre")),
          pm.nodes.paragraph.create({ id: "split-1" }, pm.text("en")),
        ]),
      );
      await fixture.persistence.journal.append(ALPHA_ID, Y.encodeStateAsUpdate(doc, before), {
        origin: "system",
        seq: 0,
      });
    });
    await fixture.draftPulls.catchUpDraft(draftId);
    expect(await fixture.collab.getDocumentAndTreeChip(THREAD_ID, TURN_ID)).toMatchObject({
      control: "undo",
    });
    expect(
      await fixture.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    expect(await fixture.draftMarkdown(draftId)).toBe("red\n\nblue\n\ngre\n\nen\n");
  } finally {
    await harness.dispose();
  }
});
