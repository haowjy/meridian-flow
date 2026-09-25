/** The real producer wakes its own runtime and the drain reuses the saved writer turn. */
import { describe, expect, it } from "vitest";
import { runtimeScenario } from "./__tests__/runtime-harness.js";
import { scriptedGateway } from "./__tests__/test-gateway.js";

describe("writer enqueue through the drain", () => {
  it("drains the pre-persisted turn instead of re-persisting it", async () => {
    const gateway = scriptedGateway({ pauseAt: [1] });
    const rig = await runtimeScenario({
      gateway,
      runStarter: { start: (id) => rig.startDrain(id) },
    });
    const sent = await rig.send(rig.thread.id, "hello");
    await gateway.untilGatewayBoundary();
    try {
      expect(await rig.repos.turns.findById(sent.userTurnId)).toMatchObject({
        role: "user",
        status: "complete",
      });
      expect(rig.runner.isThreadRunning(rig.thread.id)).toBe(true);
    } finally {
      gateway.release();
      await rig.untilSettled();
    }
    const turns = await rig.repos.turns.listByThread(rig.thread.id);
    expect(turns.filter((turn) => turn.role === "user").map((turn) => turn.id)).toEqual([
      sent.userTurnId,
    ]);
    expect(turns.filter((turn) => turn.role === "assistant")).toHaveLength(1);
  });
});
