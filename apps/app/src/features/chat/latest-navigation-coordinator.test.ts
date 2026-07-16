import { describe, expect, it, vi } from "vitest";
import { LatestNavigationCoordinator } from "./latest-navigation-coordinator";

describe("LatestNavigationCoordinator", () => {
  it("cancels turn A when turn B navigates and only B can finish", async () => {
    const coordinator = new LatestNavigationCoordinator();
    let finishA: ((value: string) => void) | undefined;
    const releasedA = vi.fn();
    const a = coordinator.run(
      (signal) =>
        new Promise<string>((resolve) => {
          finishA = resolve;
          signal.addEventListener("abort", releasedA, { once: true });
        }),
    );

    const b = coordinator.run(async (signal) => (signal.aborted ? "cancelled" : "turn-b"));
    finishA?.("late-turn-a");

    expect(releasedA).toHaveBeenCalledOnce();
    await expect(b).resolves.toBe("turn-b");
    await expect(a).resolves.toBe("late-turn-a");
  });
});
