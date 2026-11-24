import { describe, expect, it } from "vitest";
import type { ControlBody } from "../threads/index.js";
import { referenceOccurrenceContent, skillOccurrenceContent } from "./user-turn-admission.js";
import { encodeWsServerMessage, parseWsServerMessage } from "./ws-protocol.js";

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
    requestId: "r1",
    threadId: "thread-1",
    after: "0",
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
  const occurrence = {
    type: "reference",
    kind: "document",
    text: "[Gate Map](uploads://@c1/gate-map.png)",
    documentId: "33333333-3333-4333-8333-333333333333",
    uri: "uploads://@c1/gate-map.png",
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
      const folder = {
        type: "reference",
        kind: "folder",
        text: "[Maps](kb://Maps/)",
        folderId: "44444444-4444-4444-8444-444444444444",
        uri: "kb://Maps",
      };
      expect(referenceOccurrenceContent({ blockType: "text", content: folder })).toEqual(folder);
      expect(
        referenceOccurrenceContent({
          blockType: "text",
          content: { ...folder, read: { result: {}, revision: null } },
        }),
      ).toBeNull();
      expect(
        referenceOccurrenceContent({
          blockType: "media",
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
          content: { ...occurrence, uri: "uploads://@c1//gate-map.png" },
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
      expect(skillOccurrenceContent({ blockType: "media", content: skill })).toBeNull();
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
