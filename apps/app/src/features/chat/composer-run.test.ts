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
  it("is the compaction while C runs mid-response, after the reply before it settled", () => {
    const compaction = turn("c", "compaction", "pending");
    expect(composerRun([writer, turn("a", "assistant", "complete"), compaction])).toEqual({
      kind: "placeholder",
      turn: compaction,
    });
  });

  it("is the brief a Retry appended, with a message sent during it queued after", () => {
    const retry = seed("s2", "pending");
    expect(composerRun([seed("s", "error"), retry, turn("u", "user", "complete")])).toEqual({
      kind: "placeholder",
      turn: retry,
    });
  });

  it("keeps Stop for the run controller while it follows work and no reply streams", () => {
    // Between A's yield and B's start: the writer's message is still owed.
    const settledReply = [writer, turn("a", "assistant", "complete")];
    expect(composerRun(settledReply, true)).toEqual({ kind: "following" });
    expect(composerRun(settledReply, false)).toBeNull();
  });

  it("leaves a pending compaction's Stop to the compaction while the controller follows", () => {
    const compaction = turn("c", "compaction", "pending");
    expect(composerRun([writer, compaction], true)).toEqual({
      kind: "placeholder",
      turn: compaction,
    });
  });

  it("ignores a placeholder older than the latest settled reply", () => {
    expect(
      composerRun([turn("c", "compaction", "pending"), writer, turn("a", "assistant", "complete")]),
    ).toBeNull();
  });
});
