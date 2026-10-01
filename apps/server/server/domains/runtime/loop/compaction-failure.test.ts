/** Compaction failure mapping keeps the phase and measured fit evidence durable. */
import { describe, expect, it } from "vitest";
import {
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
        { reason: "context_too_large", phase: "initial_prepare" },
        "Too large.",
      ),
    ).toMatchObject({
      code: "context_too_large",
      details: { reason: "context_too_large", phase: "initial_prepare" },
    });
  });

  it("keeps the post-compaction context-window error code", () => {
    expect(
      compactionFailureMeridianError(
        { reason: "context_window_exceeded", phase: "delivery" },
        "Still too large.",
      ),
    ).toMatchObject({ code: "context_window_exceeded" });
  });
});
