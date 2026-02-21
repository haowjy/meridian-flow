import { describe, expect, it } from "vitest";
import {
  cancelChunkEditSession,
  commitChunkEditSession,
  resetChunkEditSession,
  startChunkEditSession,
  updateChunkEditSession,
} from "../chunk-editor";
import type { ReviewChunk } from "../types";

function chunk(overrides: Partial<ReviewChunk> = {}): ReviewChunk {
  return {
    id: "proposal-1-chunk-2",
    proposalId: "proposal-1",
    baseStart: 3,
    baseEnd: 6,
    deletedText: "foo",
    insertedText: "bar",
    status: "pending",
    ...overrides,
  };
}

describe("chunk editor session", () => {
  it("starts from the chunk's original inserted text", () => {
    const session = startChunkEditSession(chunk({ insertedText: "draft" }));

    expect(session).toEqual({
      proposalId: "proposal-1",
      chunkId: "proposal-1-chunk-2",
      originalInsertedText: "draft",
      draftInsertedText: "draft",
    });
  });

  it("updates, commits, and reports edited status", () => {
    const session = startChunkEditSession(chunk({ insertedText: "world" }));
    const nextSession = updateChunkEditSession(session, "planet");
    const commit = commitChunkEditSession(nextSession);

    expect(nextSession.draftInsertedText).toBe("planet");
    expect(commit).toEqual({
      proposalId: "proposal-1",
      chunkId: "proposal-1-chunk-2",
      originalInsertedText: "world",
      insertedText: "planet",
      wasEdited: true,
    });
  });

  it("supports reset and cancel helpers", () => {
    const session = startChunkEditSession(chunk({ insertedText: "world" }));
    const updated = updateChunkEditSession(session, "");
    const reset = resetChunkEditSession(updated);

    expect(reset.draftInsertedText).toBe("world");
    expect(cancelChunkEditSession()).toBeNull();
  });
});
