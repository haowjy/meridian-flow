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

  it("allows only one claim across remount or StrictMode-style duplicate effects", () => {
    const subject = store();
    stage(subject);
    subject.getState().armFirstSend("thread-1");

    const firstClaim = subject.getState().claimFirstSend("thread-1");
    expect(firstClaim).not.toBeNull();
    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();
    subject.getState().ackFirstSend("thread-1", firstClaim?.claimId ?? -1);
    expect(subject.getState().claimFirstSend("thread-1")).toBeNull();
  });

  it("restores definite failure exactly once and quarantines ambiguous admission", () => {
    const definite = store();
    stage(definite);
    definite.getState().armFirstSend("thread-1");
    const definiteClaim = definite.getState().claimFirstSend("thread-1");
    expect(
      definite.getState().nackFirstSend("thread-1", definiteClaim?.claimId ?? -1, "definite"),
    ).toBe("exact first message");
    expect(
      definite.getState().nackFirstSend("thread-1", definiteClaim?.claimId ?? -1, "definite"),
    ).toBeNull();

    const ambiguous = store();
    stage(ambiguous);
    ambiguous.getState().armFirstSend("thread-1");
    const ambiguousClaim = ambiguous.getState().claimFirstSend("thread-1");
    expect(
      ambiguous.getState().nackFirstSend("thread-1", ambiguousClaim?.claimId ?? -1, "ambiguous"),
    ).toBeNull();
    expect(ambiguous.getState().claimFirstSend("thread-1")).toBeNull();
  });
});
