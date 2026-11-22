/**
 * Shared effective-action history across card and model selectors.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - strict newest-first model history alongside the writer's card Undo (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
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
import { withBlockText, writerEdit } from "./test-support/live-room-text.js";
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it("the card's Undo leaves a change of the model's that the writer altered as it stands", async () => {
  const { harness, view, context, responseId } = await fixture();
  try {
    await harness.seedWriterDocument("red\n\nblue\n\nblack", responseId);
    const core = view.collab.agentEdit();
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    const initial = { ...context, grant: testFileGrant({ kind: "live" }, ALPHA_ID) };
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
    await writerEdit(view.rooms, ALPHA_ID, (blocks) => withBlockText(blocks, 1, "pink"));
    const text = () => harness.liveMarkdown(ALPHA_ID);
    expect(await text()).toBe("gold\n\npink\n\nwhite\n");
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: currentTurn,
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "expired" });
    // The writer changed the model's one change (two touching blocks), so it no longer stands.
    expect(await text()).toBe("gold\n\npink\n\nwhite\n");
    expect(await view.collab.getDocumentAndTreeChip(THREAD_ID, currentTurn)).toMatchObject({
      control: "view_change",
    });
  } finally {
    await harness.dispose();
  }
});
