/** Provider retry hints are recovered from SDK error response headers. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapAnthropicError } from "./anthropic/errors.js";
import { mapOpenAIResponsesError } from "./openai/errors.js";
import { mapOpenAIError } from "./openai-compatible/errors.js";
import { withProviderRetryMetadata } from "./provider-error-metadata.js";

afterEach(() => vi.useRealTimers());

describe("withProviderRetryMetadata", () => {
  it("parses millisecond and seconds headers", () => {
    expect(
      withProviderRetryMetadata(
        { headers: new Headers({ "retry-after-ms": "1250", "retry-after": "9" }) },
        { retryable: true },
      ),
    ).toEqual({ retryable: true, retryAfterMs: 1_250 });

    expect(
      withProviderRetryMetadata({ headers: { "Retry-After": "2.5" } }, { retryable: true }),
    ).toEqual({ retryable: true, retryAfterMs: 2_500 });
  });

  it("parses HTTP dates and lets x-should-retry false override classification", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    expect(
      withProviderRetryMetadata(
        {
          response: {
            headers: new Headers({
              "retry-after": "Sat, 18 Jul 2026 00:00:03 GMT",
              "x-should-retry": "false",
            }),
          },
        },
        { retryable: true },
      ),
    ).toEqual({ retryable: false, retryAfterMs: 3_000 });
  });

  it.each([
    ["Anthropic", mapAnthropicError],
    ["OpenAI Responses", mapOpenAIResponsesError],
    ["OpenAI-compatible", mapOpenAIError],
  ])("carries retry hints through the %s mapper", (_provider, mapError) => {
    expect(
      mapError({
        status: 429,
        message: "rate limited",
        headers: { "retry-after-ms": "750", "x-should-retry": "false" },
      }),
    ).toMatchObject({ retryAfterMs: 750, retryable: false });
  });
});
