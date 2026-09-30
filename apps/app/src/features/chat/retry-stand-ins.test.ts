/** Retry stand-ins sit after the turn they followed, so the chat grows below them. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { placeStandIns } from "./retry-stand-ins";
import { buildTranscriptModel } from "./transcript-model";
import { optimisticRetryReply } from "./useReplyRetry";

const seed = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    id: "s",
    role: "system",
    status,
    error: null,
    blocks: [],
    metadata: {
      kind: "derivation_seed",
      derivation: "handoff",
      sourceThreadId: "source",
      sourceRef: "c1",
      sourceTitle: "Chapter 12 plan",
      cutoffTurnId: "cut",
    },
    ...extra,
  }) as unknown as Turn;

describe("placeStandIns", () => {
  const turn = (id: string, role: string, prevTurnId: string | null) =>
    ({ id, role, prevTurnId, status: "complete", blocks: [{ id: `${id}-b` }] }) as unknown as Turn;
  const failed = seed("error", { id: "s1", prevTurnId: null });
  const reply = turn("a1", "assistant", "s1");
  // A Retry whose request was lost: its stand-in stays, failed, after the reply it followed.
  const lost = seed("error", { id: "s2", prevTurnId: "a1" });

  it("keeps a failed Retry's card after the turn it followed as the chat goes on", () => {
    // The writer kept chatting, and another tab's Retry reached the server.
    const later = [
      turn("u2", "user", "a1"),
      turn("a2", "assistant", "u2"),
      seed("pending", { id: "s3", prevTurnId: "a2" }),
    ];
    const turns = placeStandIns([failed, reply, ...later], [lost]);
    expect(turns.map((entry) => entry.id)).toEqual(["s1", "a1", "s2", "u2", "a2", "s3"]);
    const latest = buildTranscriptModel([...turns], false).rows.filter(
      (row) => row.kind === "handoff-seed" && row.latest,
    );
    expect(latest.map((row) => row.turn.id)).toEqual(["s3"]);
  });

  it("keeps stand-ins that followed the same turn in the order they were asked for", () => {
    const again = seed("pending", { id: "s3", prevTurnId: "a1" });
    const turns = placeStandIns([failed, reply, turn("u2", "user", "a1")], [lost, again]);
    expect(turns.map((entry) => entry.id)).toEqual(["s1", "a1", "s2", "s3", "u2"]);
  });

  it("puts a stand-in whose previous turn is out of view at the end", () => {
    const stray = seed("pending", { id: "s9", prevTurnId: "gone" });
    expect(placeStandIns([failed, reply], [stray]).map((entry) => entry.id)).toEqual([
      "s1",
      "a1",
      "s9",
    ]);
  });
});

describe("placeStandIns for a failed reply's Retry", () => {
  const turn = (id: string, role: string, status: string, prevTurnId: string | null) =>
    ({ id, role, status, prevTurnId, position: 1, blocks: [] }) as unknown as Turn;
  const message = turn("u1", "user", "complete", null);
  const failed = { ...turn("a1", "assistant", "error", "u1"), position: 2 } as Turn;

  it("renders the new reply below the failed one, which ends its own reply", () => {
    const reply = optimisticRetryReply({ id: "r", failed, createdAt: "2026-01-01T00:00:00Z" });
    expect(reply).toMatchObject({ prevTurnId: "a1", position: 3, status: "pending" });
    const turns = placeStandIns([message, failed], [reply]);
    expect(turns.map((entry) => entry.id)).toEqual(["u1", "a1", "r"]);
    const model = buildTranscriptModel(turns, false);
    expect(model.rows.map((row) => row.turn.id)).toEqual(["u1", "a1", "r"]);
    // The failure stays its own finished reply; the retry does not continue it.
    expect(model.continuing).toEqual([false, false, false]);
  });
});
