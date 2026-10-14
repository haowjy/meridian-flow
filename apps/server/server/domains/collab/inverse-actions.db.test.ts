/** Shared effective-action history across card and model selectors. */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
} from "./test-support/change-trail-postgres-harness.js";

import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

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
              .select({ draftId: schema.documentBranches.id })
              .from(schema.documentBranches)
              .where(
                and(
                  eq(schema.documentBranches.documentId, ALPHA_ID),
                  eq(schema.documentBranches.kind, "work_draft"),
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
