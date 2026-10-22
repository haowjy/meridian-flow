/** Durable inverse delivery to live rooms and review trails. */
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
      .update(schema.documentDrafts)
      .set({ status: "closed", closedCause: "discarded" })
      .where(
        and(
          eq(schema.documentDrafts.documentId, ALPHA_ID),
          eq(schema.documentDrafts.kind, "work_draft"),
        ),
      );
    expect(await view.draftStore.listActiveWorkDraftIds(ALPHA_ID)).toEqual([]);
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

/** The model surface runs on the same durable store as the writer's card. */
