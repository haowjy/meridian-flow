/** Provider SDK errors map to one retry policy and keep the provider's response as evidence. */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapAnthropicError } from "./anthropic/errors.js";
import { mapOpenAIError } from "./openai-compatible/errors.js";
import { withProviderRetryMetadata } from "./provider-error-metadata.js";
import { providerFetch } from "./provider-http-error.js";

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
    ["OpenAI", mapOpenAIError],
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

describe("provider HTTP failures", () => {
  const openAI402 = OpenAI.APIError.generate(
    402,
    { error: { message: "Insufficient Balance", type: "unknown_error" } },
    undefined,
    new Headers(),
  );
  const anthropic402 = Anthropic.APIError.generate(
    402,
    { type: "error", error: { type: "billing_error", message: "Insufficient Balance" } },
    undefined,
    new Headers(),
  );

  it.each([
    ["OpenAI", mapOpenAIError, openAI402],
    ["Anthropic", mapAnthropicError, anthropic402],
  ])("does not retry a %s 402 and keeps its status, message and body", (_provider, mapError, err) => {
    const mapped = mapError(err);
    expect(mapped).toMatchObject({
      code: "provider_error",
      retryable: false,
      providerResponse: { status: 402, message: "Insufficient Balance" },
    });
    expect(mapped.providerResponse?.body).toContain("Insufficient Balance");
  });

  it.each([404, 409, 413, 422])("does not retry an unnamed %i", (status) => {
    expect(mapOpenAIError({ status, message: "rejected" })).toMatchObject({
      code: "provider_error",
      retryable: false,
    });
  });

  it("still retries 429, 5xx and failures without a response", () => {
    expect(mapOpenAIError({ status: 429, message: "slow down" }).retryable).toBe(true);
    expect(mapAnthropicError({ status: 529, message: "overloaded" })).toMatchObject({
      code: "server_error",
      retryable: true,
    });
    const offline = mapOpenAIError(new TypeError("fetch failed"));
    expect(offline).toMatchObject({ code: "network_error", retryable: true });
    expect(offline.providerResponse).toBeUndefined();
  });

  it("keeps the exact body text a providerFetch client received", async () => {
    const body =
      '{"error":{"message":"Insufficient Balance","type":"unknown_error"},"request_id":"r1"}';
    vi.stubGlobal("fetch", async () => new Response(body, { status: 402 }));
    try {
      const client = new OpenAI({
        apiKey: "test",
        baseURL: "http://provider.invalid/v1",
        maxRetries: 0,
        fetch: providerFetch,
      });
      const err = await client.chat.completions
        .create({ model: "m", messages: [{ role: "user", content: "hi" }] })
        .catch((error: unknown) => error);
      expect(mapOpenAIError(err)).toMatchObject({
        code: "provider_error",
        retryable: false,
        providerResponse: { status: 402, message: "Insufficient Balance", body },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("caps the stored body at 4 KiB", () => {
    const html = `<html>${"x".repeat(10_000)}</html>`;
    const mapped = mapOpenAIError({ status: 502, message: "bad gateway", error: html });
    expect(mapped.providerResponse?.body).toHaveLength(4_096);
  });
});
