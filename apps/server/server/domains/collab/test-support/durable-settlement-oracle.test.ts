/** Contract tests for the killed-process durable settlement oracle. */
import { describe, expect, it, vi } from "vitest";
import {
  DurableSettlementOracleMismatch,
  type SettlementOracleOutput,
  settlementOracle,
} from "./durable-settlement-oracle.js";

const output = (completionState: unknown = { state: "completed", revision: 3n }) =>
  ({
    trailChanges: [{ kind: "delete", bytes: new Uint8Array([0, 1]) }],
    exactBodies: ["writer body"],
    canonicalIdentities: [
      { documentId: "b", clientID: 2, clock: 4 },
      { documentId: "a", clientID: 9, clock: 1 },
    ],
    eligibleRanges: [
      { clientID: 4, clock: 8, length: 1 },
      { clientID: 1, clock: 2, length: 3 },
    ],
    applyResult: { status: "applied" },
    completionState,
    forwardActions: [{ status: "committed", at: new Date("2026-01-02T03:04:05Z") }],
  }) satisfies SettlementOracleOutput;

describe("settlementOracle", () => {
  it("kills warm state before PostgreSQL-only recovery and compares normalized output", async () => {
    const calls: string[] = [];
    const result = await settlementOracle({
      runWarm: async () => {
        calls.push("warm");
        return output();
      },
      commitColdSubject: async () => {
        calls.push("commit-cold");
      },
      destroyWarmState: async () => {
        calls.push("destroy");
      },
      recoverFromPostgres: async () => {
        calls.push("recover-cold");
        const cold = output();
        return {
          ...cold,
          canonicalIdentities: [...cold.canonicalIdentities].reverse(),
          eligibleRanges: [...cold.eligibleRanges].reverse(),
        };
      },
    });

    expect(calls).toEqual(["warm", "commit-cold", "destroy", "recover-cold"]);
    expect(result.cold).toEqual(result.warm);
  });

  it("rejects any cold completion difference", async () => {
    const destroyWarmState = vi.fn(async () => {});
    await expect(
      settlementOracle({
        runWarm: async () => output(),
        commitColdSubject: async () => {},
        destroyWarmState,
        recoverFromPostgres: async () => output({ state: "pending", revision: 3n }),
      }),
    ).rejects.toBeInstanceOf(DurableSettlementOracleMismatch);
    expect(destroyWarmState).toHaveBeenCalledOnce();
  });
});
