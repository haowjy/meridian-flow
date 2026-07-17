/** Durable real-adapter probe for stale sibling-Work Apply behavior. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createHarness,
  resetDatabase,
} from "./test-support/change-trail-postgres-harness.js";
import {
  type CrossWorkProbeObservation,
  runCrossWorkProbe,
} from "./test-support/cross-work-probe-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

const expectEnhancements = process.env.EXPECT_CROSS_WORK_ENHANCEMENTS === "1";

describe("cross-Work merge mechanics probe (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("Case A: records stale conflicting manual Apply behavior", async () => {
    const harness = createHarness();
    const observation = await runCrossWorkProbe(harness.crossWorkProbeFixture(), "manual");
    writeObservation(observation);

    expect(observation.aApply).toMatchObject({
      status: "pushed",
      liveOriginTypes: expect.arrayContaining(["system"]),
    });
    if (expectEnhancements) {
      expect(observation.bApply.status).toBe("push_concurrent_conflict");
      expect(observation.approvedTextSurvived).toBe(true);
    } else {
      expect(observation.bApply.status).toBe("pushed");
    }
    harness.destroyWarmState();
  });

  it("Case B: records stale apply_and_trail settlement and echo behavior", async () => {
    const harness = createHarness();
    const observation = await runCrossWorkProbe(harness.crossWorkProbeFixture(), "auto");
    writeObservation(observation);

    expect(observation.aApply).toMatchObject({
      status: "pushed",
      liveOriginTypes: expect.arrayContaining(["system"]),
    });
    expect(observation.bApply.status).toBe("pushed");
    expect(observation.approvedTextSurvived).toBe(false);
    if (expectEnhancements) {
      expect(observation.protection.classification).toBe("protected");
      expect(observation.protection.capturedBodies.join("\n")).toContain(
        "Writer-approved Work A text.",
      );
      expect(observation.protection.restoreAvailable).toBe(true);
      expect(observation.protection.restoreOutcome).toBe("applied");
      expect(observation.protection.manuscriptAfterRestore).toContain(
        "Writer-approved Work A text.",
      );
      expect(JSON.stringify(observation.echo)).toContain("Writer-approved Work A text.");
    } else {
      expect(observation.protection.classification).toBe("ordinary");
      expect(observation.protection.capturedBodies).toEqual([]);
      expect(observation.protection.notices).toEqual([]);
      expect(observation.protection.restoreAvailable).toBe(false);
      expect(observation.protection.restoreOutcome).toBeNull();
    }
    harness.destroyWarmState();
  });
});

function writeObservation(observation: CrossWorkProbeObservation): void {
  process.stdout.write(
    `\nCROSS_WORK_PROBE ${observation.case.toUpperCase()}\n${JSON.stringify(observation, null, 2)}\n`,
  );
}
