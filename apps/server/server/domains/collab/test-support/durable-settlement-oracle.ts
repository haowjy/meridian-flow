/** Killed-process settlement equivalence oracle over normalized durable outputs. */
import { isDeepStrictEqual } from "node:util";
import type { LineageRange } from "@meridian/agent-edit";

export type CanonicalSettlementIdentity = {
  documentId: string;
  clientID: number;
  clock: number;
};

export type CausalMembership = {
  evidenceId: string;
  included: readonly LineageRange[];
};

export type SettlementOracleOutput = {
  trailChanges: readonly unknown[];
  exactBodies: readonly string[];
  canonicalIdentities: readonly CanonicalSettlementIdentity[];
  causalMembership: readonly CausalMembership[];
  eligibleRanges: readonly LineageRange[];
  applyResult: unknown;
  completionState: unknown;
  forwardActions: readonly unknown[];
};

export type DurableSettlementFixture = {
  /** Runs a fresh fixture through commit and ordinary warm completion. */
  runWarm(): Promise<SettlementOracleOutput>;
  /** Runs the same fresh fixture only through its PostgreSQL commit boundary. */
  commitColdSubject(): Promise<void>;
  /** Destroys coordinators, Y.Docs, transitions, and all process-local caches. */
  destroyWarmState(): Promise<void>;
  /** Builds a new facade from PostgreSQL alone, recovers, and observes completion. */
  recoverFromPostgres(): Promise<SettlementOracleOutput>;
};

export type SettlementOracleResult = {
  warm: SettlementOracleOutput;
  cold: SettlementOracleOutput;
};

/**
 * The fixture owns database isolation because warm and cold runs need identical,
 * fixture-defined durable inputs. This function owns the mandatory kill boundary
 * and the one normalized comparison used by every settlement regression.
 */
export async function settlementOracle(
  fixture: DurableSettlementFixture,
): Promise<SettlementOracleResult> {
  const warm = normalizeSettlementOutput(await fixture.runWarm());
  await fixture.commitColdSubject();
  await fixture.destroyWarmState();
  const cold = normalizeSettlementOutput(await fixture.recoverFromPostgres());
  if (!isDeepStrictEqual(warm, cold)) {
    throw new DurableSettlementOracleMismatch(warm, cold);
  }
  return { warm, cold };
}

export class DurableSettlementOracleMismatch extends Error {
  constructor(
    readonly warm: SettlementOracleOutput,
    readonly cold: SettlementOracleOutput,
  ) {
    super(
      `Warm and PostgreSQL-only settlement outputs differ\n${JSON.stringify({ warm, cold }, null, 2)}`,
    );
    this.name = "DurableSettlementOracleMismatch";
  }
}

export function normalizeSettlementOutput(output: SettlementOracleOutput): SettlementOracleOutput {
  const causalMembership = [...output.causalMembership]
    .map((membership) => ({
      evidenceId: membership.evidenceId,
      included: normalizeRanges(membership.included),
    }))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId))
    .map((membership, index) => ({
      ...membership,
      evidenceId: /^branch-journal:\d+$/.test(membership.evidenceId)
        ? `branch-journal:${index}`
        : membership.evidenceId,
    }));
  return {
    trailChanges: output.trailChanges.map(normalizeStructuredValue),
    exactBodies: [...output.exactBodies],
    canonicalIdentities: [...output.canonicalIdentities].sort(compareIdentity),
    causalMembership,
    eligibleRanges: normalizeRanges(output.eligibleRanges),
    applyResult: normalizeStructuredValue(output.applyResult),
    completionState: normalizeStructuredValue(output.completionState),
    forwardActions: output.forwardActions.map(normalizeStructuredValue),
  };
}

function normalizeRanges(ranges: readonly LineageRange[]): LineageRange[] {
  return [...ranges]
    .map((range) => ({ ...range }))
    .sort(
      (left, right) =>
        left.clientID - right.clientID || left.clock - right.clock || left.length - right.length,
    );
}

function compareIdentity(
  left: CanonicalSettlementIdentity,
  right: CanonicalSettlementIdentity,
): number {
  return (
    left.documentId.localeCompare(right.documentId) ||
    left.clientID - right.clientID ||
    left.clock - right.clock
  );
}

function normalizeStructuredValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeStructuredValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeStructuredValue(entry)]),
  );
}
