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
    "prompt is too long: 200001 tokens > 200000 maximum",
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
  it.each([
    "This model's maximum context length is 1048576 tokens. However, you requested 1049000 tokens (1048000 in the messages, 1000 in the completion).",
    "Your input exceeds the context window of this model. Please adjust your input and try again.",
  ])("maps DeepSeek and OpenAI payload: %s", (message) => {
    expect(
      mapProviderHttpError({ status: 400, code: "context_length_exceeded", message }),
    ).toMatchObject({ code: "context_overflow", retryable: false });
  });
  it("does not compact for an invalid Anthropic token option", () => {
    expect(
      mapProviderHttpError(
        new Anthropic.BadRequestError(400, {}, "max_tokens must be positive", new Headers()),
      ).code,
    ).toBe("invalid_request");
  });
});
