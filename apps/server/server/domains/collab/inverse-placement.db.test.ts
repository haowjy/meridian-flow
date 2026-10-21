/** Placement transitions and root-identity holds. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect, it } from "vitest";
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
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

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
    const [documentDraft] = await db
      .select()
      .from(schema.documentDrafts)
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    expect(await view.draftMarkdown(documentDraft.id)).toBe("Alpha Beta.\n\nSilver.\n");
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
