/** Route-armed first-send ownership and retry quarantine. */
import { describe, expect, it, vi } from "vitest";
import { createThreadStore } from "./thread-store";

function store() {
  return createThreadStore({
    now: 0,
    threadCache: {
      upsertThread: vi.fn(),
      patchThread: vi.fn(),
      invalidateThread: vi.fn(),
    },
  });
}

function stage(subject: ReturnType<typeof store>, threadId = "thread-1") {
  subject.getState().stageFirstSend({
    threadId,
    text: "exact first message",
    optimisticUserTurnId: "turn_local_1",
  });
}

describe("first-send handoff", () => {
  it("cannot be claimed before the matching route arms it", () => {
    const subject = store();
    stage(subject);

    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();
    subject.getState().armFirstSend("other-thread");
    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();

    subject.getState().armFirstSend("thread-1");
    expect(subject.getState().claimFirstSend("thread-1")).toMatchObject({
      threadId: "thread-1",
      text: "exact first message",
      optimisticUserTurnId: "turn_local_1",
    });
  });

  it("allows only one claim", () => {
    const subject = store();
    stage(subject);
    subject.getState().armFirstSend("thread-1");

    const firstClaim = subject.getState().claimFirstSend("thread-1");
    expect(firstClaim).not.toBeNull();
    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();
    subject.getState().ackFirstSend("thread-1", firstClaim?.claimId ?? -1);
    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();
  });

  it("retains definite failure until restoration acknowledgement", () => {
    const definite = store();
    stage(definite);
    definite.getState().armFirstSend("thread-1");
    const definiteClaim = definite.getState().claimFirstSend("thread-1");
    const claimId = definiteClaim?.claimId ?? -1;
    definite.getState().rejectFirstSend("thread-1", claimId, "definite");
    expect(definite.getState().firstSendByThreadId["thread-1"]).toMatchObject({
      status: "failed",
      text: "exact first message",
      claimId,
    });
    definite.getState().ackFirstSendDraftRestored("thread-1", claimId + 1);
    expect(definite.getState().firstSendByThreadId["thread-1"]?.status).toBe("failed");
    definite.getState().ackFirstSendDraftRestored("thread-1", claimId);
    expect(definite.getState().firstSendByThreadId["thread-1"]).toBeUndefined();
  });

  it("quarantines ambiguous admission", () => {
    const ambiguous = store();
    stage(ambiguous);
    ambiguous.getState().armFirstSend("thread-1");
    const ambiguousClaim = ambiguous.getState().claimFirstSend("thread-1");
    ambiguous.getState().rejectFirstSend("thread-1", ambiguousClaim?.claimId ?? -1, "ambiguous");
    expect(ambiguous.getState().firstSendByThreadId["thread-1"]?.status).toBe("ambiguous");
    expect(ambiguous.getState().claimFirstSend("thread-1")).toBeNull();
  });
});
