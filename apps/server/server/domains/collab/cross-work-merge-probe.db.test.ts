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
    expect(observation.bApply.status).toBe("concurrent_conflict");
    expect(observation.approvedTextSurvived).toBe(true);
    expect(observation.manuscript.afterBApply).toBe(observation.manuscript.beforeBApply);
    expect(observation.rereview).toMatchObject({
      initialStatus: "concurrent_conflict",
      selectedOperationIds: [expect.any(String)],
      applyStatus: "partial_applied",
      manuscriptAfterApply: expect.stringContaining("Work B echo probe."),
    });
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
    expect(observation.protection.classification).toBe("protected");
    expect(observation.protection.capturedBodies.join("\n")).toContain(
      "Writer-approved Work A text.",
    );
    expect(observation.protection.restoreActionable).toBe(true);
    expect(observation.protection.trailChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          navigation: expect.objectContaining({
            kind: "live_block_range",
          }),
          afterBlockIdentity: expect.objectContaining({ documentId: expect.any(String) }),
          writerProtection: expect.objectContaining({
            kind: "sweep",
            body: expect.objectContaining({ status: "available" }),
          }),
        }),
      ]),
    );
    expect(observation.protection.deliveredEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counts: expect.objectContaining({ swept: 1 }) }),
      ]),
    );
    expect(observation.protection.restoreOutcome).toBe("applied");
    expect(observation.protection.manuscriptAfterRestore).toContain("Writer-approved Work A text.");
    expect(JSON.stringify(observation.echo)).toContain("Writer-approved Work A text.");
    harness.destroyWarmState();
  });
});

function writeObservation(observation: CrossWorkProbeObservation): void {
  process.stdout.write(
    `\nCROSS_WORK_PROBE ${observation.case.toUpperCase()}\n${JSON.stringify(observation, null, 2)}\n`,
  );
}
