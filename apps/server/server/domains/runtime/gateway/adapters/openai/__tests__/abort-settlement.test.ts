import { describe, expect, it } from "vitest";
import { withMissingUsageMetering } from "../../../domain/metering.js";
import {
  accumulatorHasPartialResult,
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromResponseStreamEvent,
} from "../stream-collect.js";

describe("OpenAI aborted partial without usage", () => {
  it("flags missing_usage instead of a clean zero-token bill", () => {
    const acc = createStreamAccumulator("gpt-4o", "openai");
    for (const event of eventsFromResponseStreamEvent(
      {
        type: "response.output_text.delta",
        delta: "partial answer",
        item_id: "item_1",
        output_index: 0,
        content_index: 0,
        sequence_number: 0,
        logprobs: [],
      },
      acc,
    )) {
      void event;
    }

    expect(accumulatorHasPartialResult(acc)).toBe(true);
    const partial = buildGenerateResult(acc);
    expect(partial.usage).toEqual({ inputTokens: 0, outputTokens: 0 });

    const settled = withMissingUsageMetering(partial);
    expect(settled.providerData).toMatchObject({ meteringStatus: "missing_usage" });
  });
});
