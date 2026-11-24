/** Durable inverse delivery to live rooms and drafts. */

import { decodeEnvelope, freshPeerId, readDocument } from "@meridian/document-model";
import { nodeOf } from "@meridian/loro-prosemirror";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { inverseSchema } from "./domain/edit-excerpt.js";
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
import { inverseFixture } from "./test-support/turn-inverse-fixture.js";

const db = createTestDatabase();
const fixture = () => inverseFixture(db);
beforeEach(() => resetDatabase(db));
afterAll(() => closeDatabase(db));

it("records model undo and revert with model provenance", async () => {
  const { harness, view, responseId, context } = await fixture();
  try {
    const core = view.collab.agentEdit();
    const address = { documentId: ALPHA_ID, file: "alpha.md" };
    expect(
      await core.write(
        { ...address, command: "replace", find: "Beta", content: "Gamma", tool_use_id: "write" },
        context,
      ),
    ).toMatchObject({ status: "success" });

    expect(await core.write({ ...address, command: "undo" }, context)).toMatchObject({
      status: "success",
    });
    const again = await core.write(
      { ...address, command: "replace", find: "Beta", content: "Gamma", tool_use_id: "again" },
      context,
    );
    expect(again).toMatchObject({ status: "success" });
    expect(
      await core.write(
        { ...address, command: "revert", edit: (again as { writeId: string }).writeId },
        context,
      ),
    ).toMatchObject({ status: "success" });

    const rows = await db
      .select({
        actor: schema.documentEdits.actor,
        actorUserId: schema.documentEdits.actorUserId,
        threadId: schema.documentEdits.threadId,
        turnId: schema.documentEdits.turnId,
        responseId: schema.documentEdits.responseId,
        kind: schema.documentEdits.kind,
      })
      .from(schema.documentEdits)
      .where(
        and(
          eq(schema.documentEdits.documentId, ALPHA_ID),
          eq(schema.documentEdits.actor, "agent"),
          inArray(schema.documentEdits.kind, ["undo", "revert"]),
        ),
      )
      .orderBy(schema.documentEdits.id);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          actor: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          kind: "undo",
        },
        {
          actor: "agent",
          actorUserId: null,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          responseId,
          kind: "revert",
        },
      ]),
    );
  } finally {
    await harness.dispose();
  }
});

it("records writer card undo with the writer's user identity", async () => {
  const { harness, view, context } = await fixture();
  try {
    expect(
      await view.collab.agentEdit().write(
        {
          command: "replace",
          documentId: ALPHA_ID,
          file: "alpha.md",
          find: "Beta",
          content: "Gamma",
          tool_use_id: "write",
        },
        context,
      ),
    ).toMatchObject({ status: "success" });
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });

    const rows = await db
      .select({
        actor: schema.documentEdits.actor,
        actorUserId: schema.documentEdits.actorUserId,
        threadId: schema.documentEdits.threadId,
        turnId: schema.documentEdits.turnId,
        responseId: schema.documentEdits.responseId,
        kind: schema.documentEdits.kind,
      })
      .from(schema.documentEdits)
      .where(
        and(
          eq(schema.documentEdits.documentId, ALPHA_ID),
          eq(schema.documentEdits.actor, "human"),
          inArray(schema.documentEdits.kind, ["undo"]),
        ),
      )
      .orderBy(schema.documentEdits.id);
    expect(rows).toHaveLength(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          actor: "human",
          actorUserId: USER_ID,
          threadId: null,
          turnId: null,
          responseId: null,
          kind: "undo",
        },
      ]),
    );
  } finally {
    await harness.dispose();
  }
});

it("an already-connected live room sees the write and its Undo", async () => {
  const { harness, view, responseId, context } = await fixture();
  const room = { kind: "live", documentId: ALPHA_ID } as const;
  const peer = await view.rooms.read(room, { peer: freshPeerId() });
  const stop = view.rooms.subscribe(room, ({ batch }) => {
    peer.importBatch(decodeEnvelope(batch));
  });
  try {
    const immediate = {
      ...context,
      responseIdentity: undefined,
      actor: { kind: "agent" as const, threadId: THREAD_ID, turnId: TURN_ID, responseId },
    };
    const prose = () =>
      readDocument(peer)
        .map((block) => nodeOf(inverseSchema, block).textContent)
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
    ).toMatchObject({ status: "success" });
    await vi.waitFor(() => expect(prose()).toBe("Alpha Gamma.\n\nBlue."));
    expect(
      await view.collab.reverseTurn({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actor: { type: "user", userId: USER_ID },
      }),
    ).toMatchObject({ status: "reversed" });
    await vi.waitFor(() => expect(prose()).toBe("Alpha Beta.\n\nBlue."));
  } finally {
    stop();
    peer.free();
    await harness.dispose();
  }
});

/** The model surface runs on the same durable store as the writer's card. */
