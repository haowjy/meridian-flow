/** Retry stand-ins sit after the turn they followed, so the chat grows below them. */
import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { placeStandIns } from "./retry-stand-ins";
import { buildTranscriptModel } from "./transcript-model";

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
