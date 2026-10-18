/**
 * reviewChanges — one change per server closure class, in document order.
 *
 * Pins the grouping (never repaired on the client), document order from the
 * hunks, visible author attribution and class-owned excerpts.
 */
import { i18n } from "@lingui/core";
import type {
  DraftPreviewResponse,
  ReviewHunk,
  ReviewOperation,
} from "@meridian/contracts/branches";
import { describe, expect, it } from "vitest";

import { listed } from "@/test-support/draft-review-scope";
import {
  changeExcerpt,
  reviewChanges,
  reviewChangesOfPreview,
  wholeItemChange,
} from "./review-changes";

function op(overrides: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    closureClassId: `closure:${overrides.operationId}`,
    admissionToken: `closure:${overrides.operationId}`,
    kind: "agent",
    classification: "addition",
    ...overrides,
  };
}

function textHunk(overrides: Partial<ReviewHunk> & { hunkId: string }): ReviewHunk {
  return {
    kind: "text",
    operationIds: [],
    anchor: { relStart: "", relEnd: "" },
    spans: [],
    ...overrides,
  } as ReviewHunk;
}

describe("reviewChanges", () => {
  it("does not reconstruct or repair server class identities", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "closure:a" }),
      op({ operationId: "b", closureClassId: "closure:a+b" }),
    ];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    expect(reviewChanges(ops, hunks)).toHaveLength(2);
  });

  it("keeps the same order when a refreshed preview lists the same operations differently", () => {
    // Two changes share the hunk that places them and one has no hunk at all: ties break on the class id.
    const ops = [
      op({ operationId: "a", closureClassId: "c-b" }),
      op({ operationId: "b", closureClassId: "c-a" }),
      op({ operationId: "c", closureClassId: "c-z" }),
    ];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    const ids = (list: ReviewOperation[]) => reviewChanges(list, hunks).map((c) => c.classId);
    expect(ids(ops)).toEqual(["c-a", "c-b", "c-z"]);
    expect(ids([...ops].reverse())).toEqual(ids(ops));
  });

  describe("who wrote a change", () => {
    const written = (
      id: string,
      threadId: string | null,
      title: string | null,
      where: { actorTurnId?: string; actorToolCallId?: string } = {},
      overrides: Partial<ReviewOperation> = {},
    ) =>
      ({
        ...op({ operationId: id, closureClassId: "c" }),
        actorThreadId: threadId,
        actorThreadTitle: title,
        ...where,
        ...overrides,
      }) as ReviewOperation;

    it("orders chats by journal order, not by the order the server lists operations", () => {
      const [change] = reviewChanges(
        [written("10", "t-late", null), written("9", "t-early", null)],
        [],
      );
      expect(change.threadIds).toEqual(["t-late", "t-early"]);
    });

    it("names only chats with a visible operation: writer edits and unthreaded writes name none", () => {
      const [change] = reviewChanges(
        [
          written("4", "t-pace", "Pacing pass"),
          written("6", null, null),
          { ...op({ operationId: "writer:8", kind: "writer", closureClassId: "c" }) },
        ],
        [],
      );
      expect(change.threadIds).toEqual(["t-pace"]);
      // The class's physical suppliers are not operations of it: they arrive as
      // `closureUpdateIds` on the server and are never read here.
      const [writerOnly] = reviewChanges(
        [op({ operationId: "writer:2", kind: "writer", closureClassId: "w" })],
        [],
      );
      expect(writerOnly.attribution).toEqual({ kind: "you" });
      expect(writerOnly.threadIds).toEqual([]);
    });
  });

  it("describes a change with the writer's edits inside it once, not once per operation", () => {
    const agent = op({
      operationId: "61",
      closureClassId: "c",
      admissionToken: "c",
      classification: "rewrite",
      beforeExcerpt: "his",
      afterExcerpt: "one withered frail",
    });
    const writer = op({
      operationId: "writer:66",
      kind: "writer",
      closureClassId: "c",
      admissionToken: "c",
      classification: "rewrite",
      beforeExcerpt: "his",
      afterExcerpt: "one withered frail",
    });
    const [change] = reviewChanges([agent, writer], []);
    expect(changeExcerpt(change)).toEqual([
      { kind: "removed", text: "his" },
      { kind: "added", text: "one withered frail" },
    ]);
  });
});

describe("a change's hunks", () => {
  it("reads the semantic formatting of its class, without fake text additions or removals", () => {
    i18n.loadAndActivate({ locale: "en", messages: {} });
    const ops = [
      op({ operationId: "a", closureClassId: "c1" }),
      op({ operationId: "b", closureClassId: "c2" }),
    ];
    const hunks = [
      {
        kind: "block" as const,
        hunkId: "h1",
        operationIds: ["a"],
        anchor: { relStart: "", relEnd: "" },
        insertedBlock: { type: "paragraph", display: "red" },
        deletedBlock: { type: "paragraph", display: "red" },
        formatting: [
          { kind: "mark" as const, mark: "strong", change: "added" as const, text: "red" },
        ],
      },
      textHunk({ hunkId: "h2", operationIds: ["b"], deletedText: "old b" }),
    ];
    const [first, second] = reviewChanges(ops, hunks);
    expect(first.change.runs).toEqual([]);
    expect(changeExcerpt(first)).toEqual([{ kind: "added", text: "Bold on “red”" }]);
    expect(second.change.runs).toEqual([{ kind: "removed", text: "old b" }]);
  });
});

describe("change excerpts", () => {
  it("carries every removed and inserted run of a multi-pair replacement in document order", () => {
    const [change] = reviewChanges(
      [
        op({
          operationId: "replace",
          closureClassId: "replacement",
          classification: "rewrite",
          beforeExcerpt: "broken",
          afterExcerpt: "weathered",
        }),
      ],
      [
        textHunk({
          hunkId: "first",
          operationIds: ["replace"],
          deletedText: "broken",
          insertedText: "weathered",
        }),
        textHunk({
          hunkId: "second",
          operationIds: ["replace"],
          deletedText: "archway",
          insertedText: "gate",
        }),
        textHunk({
          hunkId: "third",
          operationIds: ["replace"],
          deletedText: "archway",
          insertedText: "gate",
        }),
      ],
    );
    expect(changeExcerpt(change)).toEqual([
      { kind: "removed", text: "broken" },
      { kind: "added", text: "weathered" },
      { kind: "removed", text: "archway" },
      { kind: "added", text: "gate" },
      { kind: "removed", text: "archway" },
      { kind: "added", text: "gate" },
    ]);
  });
});

describe("whole-item changes", () => {
  const preview = (item: Partial<typeof listed>, operations: ReviewOperation[] = []) =>
    ({
      status: "active",
      branchId: listed.branchId,
      itemKey: listed.itemKey,
      draftGeneration: 1,
      reviewRoomName: "room",
      liveRevisionToken: "l",
      draftRevisionToken: "t",
      item: { ...listed, ...item },
      operations,
      hunks: [],
    }) satisfies DraftPreviewResponse;

  it("shows a new document with no operations as exactly one change", () => {
    const changes = reviewChangesOfPreview(preview({ isNew: true, wholeItem: true }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.target).toEqual({ kind: "draft" });
  });

  it("collapses a new document's operations to one change", () => {
    const ops = [op({ operationId: "1" }), op({ operationId: "2" })];
    expect(reviewChangesOfPreview(preview({ isNew: true, wholeItem: true }, ops))).toHaveLength(1);
  });

  it("shows an image without a document-draft row by its file name, attributed to the chat that created it", () => {
    const image = {
      ...listed,
      binary: true,
      wholeItem: true,
      draftGeneration: null,
      documentName: "map.png",
      actorThreads: [{ threadId: "chat-a", title: "Chat A" }],
    };
    const change = wholeItemChange(image);
    expect(change.change.runs).toEqual([{ kind: "added", text: "map.png" }]);
    expect(change.threadIds).toEqual(["chat-a"]);
    expect(
      wholeItemChange({ ...image, actorThreads: [{ threadId: "chat-b", title: null }] }).threadIds,
    ).not.toContain("chat-a");
  });
});
