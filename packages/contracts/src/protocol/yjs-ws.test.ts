import { describe, expect, it } from "vitest";
import { encodeChangeEventWsMessage, parseYjsStatelessMessage } from "./yjs-ws.js";

function validMessage(): Parameters<typeof encodeChangeEventWsMessage>[0] {
  return {
    documentId: "document-1" as never,
    threadId: "thread-1",
    trailId: "trail-1",
    projectionRevision: 2,
    author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
    admittedByUserId: null,
    changes: [
      {
        changeId: "change-1",
        kind: "delete",
        navigation: {
          kind: "live_block_range",
          relStart: "relative-start",
          relEnd: "relative-end",
          targetBlockId: { clientID: 7, clock: 11 },
        },
        swept: true,
        excerpt: "Removed prose",
        pureDeletionOffset: null,
      },
    ],
    truncated: false,
  };
}

describe("Yjs stateless messages", () => {
  it("round-trips a validated change event", () => {
    const payload = encodeChangeEventWsMessage({
      documentId: "document-1" as never,
      threadId: "thread-1",
      trailId: "trail-1",
      projectionRevision: 2,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      admittedByUserId: null,
      changes: [
        {
          changeId: "change-1",
          kind: "delete",
          navigation: {
            kind: "deletion_boundary",
            position: "relative-position",
            affinity: "before_next",
          },
          swept: true,
          excerpt: "Removed prose",
          pureDeletionOffset: null,
        },
      ],
      truncated: false,
    });

    expect(parseYjsStatelessMessage(payload)).toEqual({
      type: "change_event",
      documentId: "document-1",
      threadId: "thread-1",
      trailId: "trail-1",
      projectionRevision: 2,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      admittedByUserId: null,
      changes: [
        {
          changeId: "change-1",
          kind: "delete",
          navigation: {
            kind: "deletion_boundary",
            position: "relative-position",
            affinity: "before_next",
          },
          swept: true,
          excerpt: "Removed prose",
          pureDeletionOffset: null,
        },
      ],
      truncated: false,
    });
  });

  it("rejects malformed and unknown stateless payloads", () => {
    expect(parseYjsStatelessMessage("not json")).toBeNull();
    expect(parseYjsStatelessMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(
      parseYjsStatelessMessage(
        JSON.stringify({
          type: "change_event",
          documentId: "document-1",
          threadId: "thread-1",
          trailId: "trail-1",
          projectionRevision: -1,
          author: { kind: "writer", userId: "user-1" },
          admittedByUserId: "user-1",
          changes: [],
          truncated: false,
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ["negative clientID", { clientID: -1, clock: 0 }],
    ["negative clock", { clientID: 0, clock: -1 }],
    ["clientID above the safe-integer bound", { clientID: Number.MAX_SAFE_INTEGER + 1, clock: 0 }],
    ["clock above the safe-integer bound", { clientID: 0, clock: Number.MAX_SAFE_INTEGER + 1 }],
  ])("rejects %s", (_case, targetBlockId) => {
    const message = validMessage();
    const change = message.changes[0];
    if (change?.navigation.kind !== "live_block_range") {
      throw new Error("invalid test fixture");
    }
    change.navigation.targetBlockId = targetBlockId;

    expect(
      parseYjsStatelessMessage(JSON.stringify({ type: "change_event", ...message })),
    ).toBeNull();
  });

  it("rejects excerpts longer than 500 characters", () => {
    const message = validMessage();
    const change = message.changes[0];
    if (!change) throw new Error("invalid test fixture");
    change.excerpt = "x".repeat(501);

    expect(
      parseYjsStatelessMessage(JSON.stringify({ type: "change_event", ...message })),
    ).toBeNull();
  });

  it("rejects invalid pure-deletion offsets", () => {
    const message = validMessage();
    const change = message.changes[0];
    if (!change) throw new Error("invalid test fixture");
    change.pureDeletionOffset = -1;

    expect(
      parseYjsStatelessMessage(JSON.stringify({ type: "change_event", ...message })),
    ).toBeNull();
  });

  it("rejects an agent author from a different thread", () => {
    const message = validMessage();
    message.author = { kind: "agent", threadId: "thread-2", turnId: "turn-1" };

    expect(
      parseYjsStatelessMessage(JSON.stringify({ type: "change_event", ...message })),
    ).toBeNull();
  });

  it("validates server projections before encoding", () => {
    const message = validMessage();
    const change = message.changes[0];
    if (!change) throw new Error("invalid test fixture");
    change.excerpt = "x".repeat(501);

    expect(() => encodeChangeEventWsMessage(message)).toThrow();
  });
});
