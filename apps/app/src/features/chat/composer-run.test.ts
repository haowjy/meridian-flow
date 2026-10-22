import type { Turn } from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import { composerRun } from "./composer-run";

function turn(id: string, role: Turn["role"], status: Turn["status"]): Turn {
  return { id, role, status, blocks: [] } as unknown as Turn;
}

function seed(id: string, status: Turn["status"]): Turn {
  return {
    ...turn(id, "system", status),
    metadata: { kind: "derivation_seed", derivation: "handoff", sourceThreadId: "source" },
  } as Turn;
}

const writer = turn("u", "user", "complete");

describe("composerRun: what the composer's Stop acts on", () => {
  it("is the brief a Retry appended, with a message sent during it queued after", () => {
    const retry = seed("s2", "pending");
    expect(composerRun([seed("s", "error"), retry, turn("u", "user", "complete")])).toEqual({
      kind: "placeholder",
      turn: retry,
    });
  });

  it("leaves a compaction to the record: the chat Stop handles it", () => {
    expect(composerRun([writer, turn("c", "compaction", "pending")])).toBeNull();
  });

  it("ignores a placeholder older than the latest settled reply", () => {
    expect(
      composerRun([seed("s", "pending"), writer, turn("a", "assistant", "complete")]),
    ).toBeNull();
  });
});
