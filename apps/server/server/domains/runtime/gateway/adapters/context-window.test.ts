/** Provider window failures share one code; invalid token parameters do not trigger compaction. */
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "./anthropic/stream-collect.js";
import { mapProviderHttpError } from "./provider-http-error.js";

describe("context window normalization", () => {
  it("maps Anthropic's untyped window stop and keeps paid usage", () => {
    const acc = createStreamAccumulator("writer", "anthropic");
    const events = [
      ...eventsFromAnthropicStreamEvent(
        {
          type: "message_delta",
          delta: { stop_reason: "model_context_window_exceeded", stop_sequence: null },
          usage: { input_tokens: 100, output_tokens: 12 },
        } as never,
        acc,
      ),
    ];
    expect(events.at(-1)).toMatchObject({
      type: "error",
      code: "context_overflow",
      retryable: false,
      result: { finishReason: "error", usage: { inputTokens: 100, outputTokens: 12 } },
    });
  });
  it("maps OpenAI-shaped window errors but not invalid token options", () => {
    expect(
      mapProviderHttpError({ status: 400, message: "maximum context length exceeded" }).code,
    ).toBe("context_overflow");
    expect(mapProviderHttpError({ status: 400, message: "max_tokens must be positive" }).code).toBe(
      "invalid_request",
    );
  });
  it.each([
    "input length and max_tokens exceed context limit: 185000 + 16384 > 200000",
  ])("maps Anthropic invalid_request_error: %s", (message) => {
    expect(
      mapProviderHttpError(
        new Anthropic.BadRequestError(
          400,
          { type: "error", error: { type: "invalid_request_error", message } },
          message,
          new Headers(),
        ),
      ),
    ).toMatchObject({ code: "context_overflow", retryable: false });
  });
});
