import { describe, expect, it } from "vitest";
import {
  cancelContextProjectAttempt,
  contextProjectPhase,
  INITIAL_CONTEXT_PROJECT_AUTHORITY,
  settleContextProjectBootstrap,
  updateContextProjectReadiness,
} from "./context-project-phase";

const ready = { status: "ready" as const, workId: "work-1", source: "route" as const };

describe("Context project authority", () => {
  it.each([
    "loading",
    "error",
    "normalizing",
  ] as const)("withholds initial authority while Work is %s", (status) => {
    const next = updateContextProjectReadiness(INITIAL_CONTEXT_PROJECT_AUTHORITY, true, {
      status,
      workId: "work-1",
    });
    expect(contextProjectPhase(next.authority)).toMatchObject({
      status: "waiting-for-work",
      work: { status },
    });
    expect(next.effect).toBeNull();
  });

  it("withholds initial authority for an empty Work catalog", () => {
    const next = updateContextProjectReadiness(INITIAL_CONTEXT_PROJECT_AUTHORITY, true, {
      status: "empty",
    });
    expect(contextProjectPhase(next.authority)).toMatchObject({ status: "waiting-for-work" });
  });

  it("starts raw validation once and Strict replay adopts it with a fresh attempt", () => {
    const first = updateContextProjectReadiness(INITIAL_CONTEXT_PROJECT_AUTHORITY, true, ready);
    expect(first.effect).toMatchObject({ raw: "start", attempt: { token: 1 } });
    const cancelled = cancelContextProjectAttempt(first.authority, 1);
    const replay = updateContextProjectReadiness(cancelled, true, ready);
    expect(replay.effect).toMatchObject({ raw: "adopt", attempt: { token: 2 } });
    expect(replay.authority.rawValidation).toBe("running");

    expect(settleContextProjectBootstrap(replay.authority, 1)).toMatchObject({
      hasCompletedBootstrap: false,
      rawValidation: "settled",
    });
    const live = settleContextProjectBootstrap(replay.authority, 2);
    expect(contextProjectPhase(live)).toEqual({ status: "live", workId: "work-1" });
  });

  it("adopts a settled raw operation after readiness cancellation", () => {
    const first = updateContextProjectReadiness(INITIAL_CONTEXT_PROJECT_AUTHORITY, true, ready);
    const waiting = updateContextProjectReadiness(first.authority, true, {
      status: "loading",
      workId: "work-1",
    }).authority;
    const settled = settleContextProjectBootstrap(waiting, 1);
    expect(settled).toMatchObject({ rawValidation: "settled", hasCompletedBootstrap: false });

    const replacement = updateContextProjectReadiness(settled, true, ready);
    expect(replacement.effect?.raw).toBe("adopt");
    expect(contextProjectPhase(settleContextProjectBootstrap(replacement.authority, 2))).toEqual({
      status: "live",
      workId: "work-1",
    });
  });

  it.each([
    { status: "loading" as const, workId: "work-1" },
    { status: "error" as const, workId: "work-1" },
    { status: "normalizing" as const, workId: "work-1" },
    { status: "empty" as const },
  ])("suspends after live for $status and never restores bootstrap", (work) => {
    const attempt = updateContextProjectReadiness(INITIAL_CONTEXT_PROJECT_AUTHORITY, true, ready);
    const live = settleContextProjectBootstrap(attempt.authority, 1);
    const suspended = updateContextProjectReadiness(live, true, work);
    expect(contextProjectPhase(suspended.authority).status).toBe("suspended");
    expect(suspended.effect).toBeNull();

    const resumed = updateContextProjectReadiness(suspended.authority, true, {
      ...ready,
      workId: "work-2",
    });
    expect(resumed.effect).toBeNull();
    expect(contextProjectPhase(resumed.authority)).toEqual({ status: "live", workId: "work-2" });
    expect(resumed.authority.rawValidation).toBe("settled");
  });
});
