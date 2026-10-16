import { describe, expect, it } from "vitest";
import type { ControlBody } from "../threads/index.js";
import { assertAvailabilityGeneration } from "./context-availability.js";
import { apiProjectDocumentAddressPath } from "./paths.js";
import { referenceOccurrenceContent, skillOccurrenceContent } from "./user-turn-admission.js";
import { encodeWsServerMessage, parseWsServerMessage } from "./ws-protocol.js";
import { encodeChangeEventWsMessage, parseYjsStatelessMessage } from "./yjs-ws.js";

function subscribedFrameWithQueuedControl(control: ControlBody): string {
  const queued = [
    {
      id: "control-1",
      seq: 7,
      intent: "control",
      control,
      provenance: { kind: "writer", actorId: "user-1" },
      deliveryState: "waiting",
      summary: "",
      enqueuedAt: "2026-10-11T00:00:00.000Z",
    },
  ];
  return JSON.stringify({
    type: "subscribed",
    threadId: "thread-1",
    catchup: [],
    state: {
      threadId: "thread-1",
      status: { kind: "awake", phase: "generating", cancelRequested: false },
      activity: { children: [] },
      runState: {
        version: "6999",
        items: queued,
        sentThrough: 0,
        execution: null,
        mode: "direct",
        blocked: null,
      },
      resumeAfterSeq: "6",
    },
  });
}

describe("thread socket frames", () => {
  it.each<ControlBody>([
    { kind: "compact", instructions: "keep the duel" },
    { kind: "write_mode", mode: "draft" },
  ])("round-trips a subscription with a queued $kind control", (control) => {
    const parsed = parseWsServerMessage(subscribedFrameWithQueuedControl(control));

    expect(parsed?.type).toBe("subscribed");
    if (parsed?.type !== "subscribed") return;
    expect(parsed.state.runState.items[0]?.control).toEqual(control);
    expect(parseWsServerMessage(encodeWsServerMessage(parsed))).toEqual(parsed);
  });

  it("rejects a control outside the vocabulary", () => {
    const frame = subscribedFrameWithQueuedControl({ kind: "write_mode", mode: "review" } as never);

    expect(parseWsServerMessage(frame)).toBeNull();
  });
});

{
  function validMessage(): Parameters<typeof encodeChangeEventWsMessage>[0] {
    return {
      documentId: "document-1" as never,
      threadId: "thread-1",
      trailId: "trail-1",
      projectionRevision: 2,
      author: { kind: "agent", threadId: "thread-1", turnId: "turn-1" },
      changes: [
        {
          admittedByUserId: null,
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
        changes: [
          {
            admittedByUserId: null,
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
        changes: [
          {
            admittedByUserId: null,
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
            changes: [],
            truncated: false,
          }),
        ),
      ).toBeNull();
    });

    it.each([
      [
        "clientID above the safe-integer bound",
        { clientID: Number.MAX_SAFE_INTEGER + 1, clock: 0 },
      ],
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
}

{
  const occurrence = {
    type: "reference",
    text: "[Gate Map](uploads://@/gate-map.png)",
    documentId: "33333333-3333-4333-8333-333333333333",
    uri: "uploads://@/gate-map.png",
  };

  describe("referenceOccurrenceContent", () => {
    it("recognizes only exact structured text-block content", () => {
      expect(
        referenceOccurrenceContent({
          blockType: "text",
          content: occurrence,
        }),
      ).toEqual(occurrence);
      expect(
        referenceOccurrenceContent({
          blockType: "text",
          content: { ...occurrence, extra: true },
        }),
      ).toBeNull();
      expect(
        referenceOccurrenceContent({
          blockType: "image",
          content: occurrence,
        }),
      ).toBeNull();
      expect(
        referenceOccurrenceContent({
          blockType: "text",
          content: { ...occurrence, documentId: "not-an-id" },
        }),
      ).toBeNull();
      expect(
        referenceOccurrenceContent({
          blockType: "text",
          content: { ...occurrence, uri: "uploads://@//gate-map.png" },
        }),
      ).toBeNull();
    });
  });

  const skill = {
    type: "skill",
    text: "/writing-principles",
    slug: "writing-principles",
    name: "Writing principles",
    description: "Reader reward.",
  };

  describe("skillOccurrenceContent", () => {
    it("recognizes only exact structured text-block content", () => {
      expect(skillOccurrenceContent({ blockType: "text", content: skill })).toEqual(skill);
      expect(
        skillOccurrenceContent({
          blockType: "text",
          content: { ...skill, extra: true },
        }),
      ).toBeNull();
      expect(skillOccurrenceContent({ blockType: "image", content: skill })).toBeNull();
      expect(
        skillOccurrenceContent({
          blockType: "text",
          content: { ...skill, text: "/other" },
        }),
      ).toBeNull();
    });
  });

  it("keeps reference identity recognizable after a server read snapshot is added", () => {
    const content = {
      ...occurrence,
      read: { result: { command: "read", status: "document_not_found" }, revision: null },
    };
    expect(referenceOccurrenceContent({ blockType: "text", content })).toEqual(content);
    expect(
      referenceOccurrenceContent({
        blockType: "text",
        content: { ...occurrence, read: "fake" },
      }),
    ).toBeNull();
  });
}

describe("live document session authority contracts", () => {
  it("accepts only canonical nonnegative decimal generations", () => {
    for (const generation of ["0", "1", "10", "99999999999999999999"]) {
      expect(() => assertAvailabilityGeneration(generation)).not.toThrow();
    }
    for (const generation of ["", "+1", "-1", " 1", "1 ", "0x10", "01", "00"]) {
      expect(() => assertAvailabilityGeneration(generation)).toThrow(TypeError);
    }
  });
});

it("serializes the Work and item selector without changing the manuscript owner", () => {
  const address = apiProjectDocumentAddressPath("project", "manuscript", "chapters/one", {
    workId: null,
    review: { workId: "review-work", itemKey: "draft:document" },
  });
  const query = new URL(address, "https://example.test").searchParams;
  expect(Object.fromEntries(query)).toEqual({
    path: "chapters/one",
    reviewWorkId: "review-work",
    itemKey: "draft:document",
  });
  expect(
    apiProjectDocumentAddressPath("project", "manuscript", "chapters/one", { workId: null }),
  ).toBe("/api/projects/project/context/manuscript/address?path=chapters%2Fone");
});
