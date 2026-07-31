/** Durable real-adapter probe for stale sibling-Work Apply behavior. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  createHarness,
  resetDatabase,
} from "./test-support/change-trail-postgres-harness.js";
import {
  type CrossWorkProbeResult,
  runCrossWorkProbe,
} from "./test-support/cross-work-probe-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("cross-Work merge mechanics probe (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("Case A: manual Apply merges a stale same-block edit and records its receipt", async () => {
    const harness = createHarness();
    const result = await runCrossWorkProbe(harness.crossWorkProbeFixture(), "manual");
    writeResult(result);

    expect(result.aApply).toMatchObject({
      status: "pushed",
      liveOriginTypes: expect.arrayContaining(["system"]),
    });
    expect(result.bApply.status).toBe("applied");
    expect(result.approvedTextSurvived).toBe(true);
    expect(result.manuscript.afterBApply).not.toBe(result.manuscript.beforeBApply);
    expect(result.manuscript.afterBApply).toContain("Work B stale replacement.");
    expect(result.manuscript.afterBApply).toContain("Writer-approved Work A text.");
    expect(result.protection.classification).toBe("ordinary");
    expect(result.protection.capturedBodies.join("\n")).toContain("Writer-approved Work A text.");
    expect(result.protection.trailChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ beforeText: expect.stringContaining("Writer-approved") }),
      ]),
    );
    harness.destroyWarmState();
  });

  it("Case B: records stale apply_and_trail settlement and receipt behavior", async () => {
    const harness = createHarness();
    const result = await runCrossWorkProbe(harness.crossWorkProbeFixture(), "auto");
    writeResult(result);

    expect(result.aApply).toMatchObject({
      status: "pushed",
      liveOriginTypes: expect.arrayContaining(["system"]),
    });
    expect(result.bApply.status).toBe("pushed");
    expect(result.approvedTextSurvived).toBe(false);
    expect(result.protection.classification).toBe("ordinary");
    expect(result.protection.capturedBodies.join("\n")).toContain("Writer-approved Work A text.");
    expect(result.protection.trailChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          navigation: expect.objectContaining({
            kind: "live_block_range",
          }),
          afterBlockIdentity: expect.objectContaining({ documentId: expect.any(String) }),
          beforeText: expect.stringContaining("Writer-approved"),
        }),
      ]),
    );
    expect(result.protection.deliveredEvents).toEqual(
      expect.arrayContaining([expect.objectContaining({ counts: expect.any(Object) })]),
    );
    const receipt = JSON.stringify(result.echo);
    expect(receipt).toContain("Work B stale replacement.");
    expect(receipt).toContain("Writer-approved Work A text.");
    expect(receipt).toContain('"concurrent":{"runs":[{"origin":"agent"');
    harness.destroyWarmState();
  });
});

function writeResult(result: CrossWorkProbeResult): void {
  process.stdout.write(
    `\nCROSS_WORK_PROBE ${result.case.toUpperCase()}\n${JSON.stringify(result, null, 2)}\n`,
  );
}
