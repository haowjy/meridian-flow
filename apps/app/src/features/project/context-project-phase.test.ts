import { describe, expect, it } from "vitest";
import {
  type ContextProjectPhase,
  contextProjectPhaseForReadiness,
  settleContextProjectBootstrap,
} from "./context-project-phase";

const initial: ContextProjectPhase = { status: "waiting-for-desk", generation: 0 };

describe("Context project authority phase", () => {
  it.each([
    "loading",
    "error",
    "normalizing",
  ] as const)("withholds live authority while Work is %s", (status) => {
    const phase = contextProjectPhaseForReadiness(initial, true, { status, workId: "work-1" });
    expect(phase).toMatchObject({ status: "waiting-for-work", work: { status } });
  });

  it("withholds live authority for an empty Work catalog", () => {
    expect(contextProjectPhaseForReadiness(initial, true, { status: "empty" })).toMatchObject({
      status: "waiting-for-work",
      work: { status: "empty" },
    });
  });

  it("enters live only after the matching bootstrap generation settles", () => {
    const bootstrapping = contextProjectPhaseForReadiness(initial, true, {
      status: "ready",
      workId: "work-1",
      source: "route",
    });
    expect(bootstrapping.status).toBe("bootstrapping");
    expect(settleContextProjectBootstrap(bootstrapping, 99, "work-1")).toBe(bootstrapping);
    expect(
      settleContextProjectBootstrap(bootstrapping, bootstrapping.generation, "work-1"),
    ).toEqual({ status: "live", generation: 1, workId: "work-1" });
  });

  it("changes ready Work inside live authority without reopening bootstrap", () => {
    const live: ContextProjectPhase = { status: "live", generation: 3, workId: "work-1" };
    expect(
      contextProjectPhaseForReadiness(live, true, {
        status: "ready",
        workId: "work-2",
        source: "route",
      }),
    ).toEqual({ status: "live", generation: 3, workId: "work-2" });
  });
});
