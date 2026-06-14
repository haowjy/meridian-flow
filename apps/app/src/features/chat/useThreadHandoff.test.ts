/**
 * useThreadHandoff tests — covers pure cursor derivation used by snapshot-based
 * mount resume before the hook calls the thread run controller.
 */
import { describe, expect, it } from "vitest";

import { activeSnapshotResumeAfterSeq, lastSeenSeqFromSnapshotNextSeq } from "./useThreadHandoff";

describe("lastSeenSeqFromSnapshotNextSeq", () => {
  it("converts a snapshot nextSeq watermark to the last-seen WS cursor", () => {
    expect(lastSeenSeqFromSnapshotNextSeq("1001")).toBe("1000");
  });

  it("refuses invalid or zero-replay cursors", () => {
    expect(lastSeenSeqFromSnapshotNextSeq("1")).toBeNull();
    expect(lastSeenSeqFromSnapshotNextSeq("0")).toBeNull();
    expect(lastSeenSeqFromSnapshotNextSeq("not-a-seq")).toBeNull();
  });
});

describe("activeSnapshotResumeAfterSeq", () => {
  it("uses the active snapshot projection watermark instead of nextSeq minus one", () => {
    expect(
      activeSnapshotResumeAfterSeq({
        threadId: "thread-1",
        status: "active",
        runningTurnId: "turn-running",
        currentAgent: null,
        nextSeq: "9000",
        resumeAfterSeq: "3999",
      }),
    ).toBe("3999");
  });

  it("does not produce a blind replay cursor for non-active snapshots", () => {
    expect(
      activeSnapshotResumeAfterSeq({
        threadId: "thread-1",
        status: "idle",
        runningTurnId: null,
        currentAgent: null,
        nextSeq: "9000",
        resumeAfterSeq: "0",
      }),
    ).toBeNull();
  });
});
