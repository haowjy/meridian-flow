/** Compaction failure mapping keeps the phase and measured fit evidence durable. */
import { describe, expect, it } from "vitest";
import {
  CompactionFailureError,
  CompactionPreparationError,
  compactionFailureFrom,
  compactionFailureMeridianError,
  summaryCompactionFailure,
} from "./compaction/decision.js";

describe("compaction failure outcomes", () => {
  it.each([
    "max_tokens",
    "provider_error",
    "tool_use",
    "empty_text",
  ] as const)("maps summary rejection %s to the summary phase", (reason) => {
    expect(summaryCompactionFailure(reason)).toEqual({ reason, phase: "summary" });
  });

  it("keeps the refusal vocabulary for an initial fit failure", () => {
    expect(
      compactionFailureFrom(new CompactionPreparationError("context_too_large"), "initial_prepare"),
    ).toEqual({ reason: "context_too_large", phase: "initial_prepare" });
  });

  it("maps unknown initial preparation exceptions to the generic reason and their phase", () => {
    expect(compactionFailureFrom(new Error("composition failed"), "initial_prepare")).toEqual({
      reason: "compaction_failed",
      phase: "initial_prepare",
    });
  });

  it("preserves late fit measurements through delivery", () => {
    const failure = {
      reason: "context_too_large" as const,
      phase: "late_arrival" as const,
      estimatedTokens: 4_321,
      fitLimitTokens: 2_500,
    };
    expect(compactionFailureFrom(new CompactionFailureError(failure), "delivery")).toEqual(failure);
  });

  it("maps unknown late-arrival exceptions to the late-arrival phase", () => {
    expect(compactionFailureFrom(new Error("successor overflow"), "late_arrival")).toEqual({
      reason: "compaction_failed",
      phase: "late_arrival",
    });
  });

  it("keeps a non-fit delivery failure in the delivery phase", () => {
    expect(compactionFailureFrom(new Error("late image lookup failed"), "delivery")).toEqual({
      reason: "compaction_failed",
      phase: "delivery",
    });
  });

  it("maps unknown delivery exceptions to the delivery phase", () => {
    expect(compactionFailureFrom(new Error("split failed"), "delivery")).toEqual({
      reason: "compaction_failed",
      phase: "delivery",
    });
  });

  it("keeps an unclassified summary rejection generic but scoped to summary", () => {
    expect(summaryCompactionFailure(undefined)).toEqual({
      reason: "compaction_failed",
      phase: "summary",
    });
  });

  it("keeps summary reasons in details and uses the compaction error-code family", () => {
    expect(
      compactionFailureMeridianError(
        { reason: "provider_error", phase: "summary" },
        "Compaction failed.",
      ),
    ).toMatchObject({
      code: "compaction_failed",
      source: "system",
      details: { reason: "provider_error", phase: "summary" },
    });
  });

  it("keeps writer-facing refusal codes", () => {
    expect(
      compactionFailureMeridianError(
        { reason: "context_too_large", phase: "late_arrival" },
        "Too large.",
      ),
    ).toMatchObject({
      code: "context_too_large",
      details: { reason: "context_too_large", phase: "late_arrival" },
    });
  });
});
