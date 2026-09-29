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
  it("is idle when nothing runs", () => {
    expect(composerRun([writer, turn("a", "assistant", "complete")])).toBeNull();
  });

  it("is the reply while it streams", () => {
    expect(composerRun([writer, turn("a", "assistant", "streaming")])).toEqual({ kind: "reply" });
  });

  it("is the compaction while C runs mid-response, after the reply before it settled", () => {
    const compaction = turn("c", "compaction", "pending");
    expect(composerRun([writer, turn("a", "assistant", "complete"), compaction])).toEqual({
      kind: "placeholder",
      turn: compaction,
    });
  });

  it("is the handoff brief while its seed is pending, with no lease or phase", () => {
    const brief = seed("s", "pending");
    expect(composerRun([brief])).toEqual({ kind: "placeholder", turn: brief });
  });

  it("is the brief a Retry appended, with a message sent during it queued after", () => {
    const retry = seed("s2", "pending");
    expect(composerRun([seed("s", "error"), retry, turn("u", "user", "complete")])).toEqual({
      kind: "placeholder",
      turn: retry,
    });
  });

  it("is idle once the brief ends, and never a pending system turn that is not a seed", () => {
    expect(composerRun([seed("s", "cancelled")])).toBeNull();
    expect(composerRun([writer, turn("x", "system", "pending")])).toBeNull();
  });

  it("is idle once the compaction settles", () => {
    expect(
      composerRun([
        writer,
        turn("a", "assistant", "complete"),
        turn("c", "compaction", "complete"),
      ]),
    ).toBeNull();
  });

  it("ignores a placeholder older than the latest settled reply", () => {
    expect(
      composerRun([turn("c", "compaction", "pending"), writer, turn("a", "assistant", "complete")]),
    ).toBeNull();
  });
});
