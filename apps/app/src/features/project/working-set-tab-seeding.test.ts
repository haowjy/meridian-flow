import { describe, expect, it } from "vitest";
import type { WorkingSetHydrationPlan } from "@/client/working-set";
import { ContextDeskBootstrapGate } from "./working-set-tab-seeding";

describe("Context desk entry bootstrap", () => {
  it("validates once per hydration generation and never restarts for A to B to A Work changes", () => {
    const gate = new ContextDeskBootstrapGate();
    const hydration: WorkingSetHydrationPlan = { status: "disabled" };
    const firstA = gate.begin(hydration, "project-1", "work-a");

    if (!firstA) throw new Error("expected first hydration scope");
    expect(gate.isLive(firstA, "work-a")).toBe(true);
    expect(gate.isLive(firstA, "work-b")).toBe(false);
    expect(gate.begin(hydration, "project-1", "work-b")).toBeNull();
    expect(gate.begin(hydration, "project-1", "work-a")).toBeNull();

    const retriedHydration: WorkingSetHydrationPlan = { status: "disabled" };
    const retried = gate.begin(retriedHydration, "project-1", "work-a");
    if (!retried) throw new Error("expected retried hydration scope");
    expect(gate.isLive(firstA, "work-a")).toBe(false);
    expect(gate.isLive(retried, "work-a")).toBe(true);
  });

  it("makes disposal invalidate an in-flight bootstrap scope", () => {
    const gate = new ContextDeskBootstrapGate();
    const scope = gate.begin({ status: "disabled" }, "project-1", "work-a");
    if (!scope) throw new Error("expected hydration scope");
    gate.dispose();
    expect(gate.isLive(scope, "work-a")).toBe(false);
  });
});
