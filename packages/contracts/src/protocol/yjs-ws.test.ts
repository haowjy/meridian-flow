import { describe, expect, it } from "vitest";
import { encodeChangeEventWsMessage, parseYjsStatelessMessage } from "./yjs-ws.js";

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
});
