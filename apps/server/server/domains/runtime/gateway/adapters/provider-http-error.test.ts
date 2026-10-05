/** Provider SDK errors map to one retry policy and keep the provider's response as evidence. */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_ERROR_PATTERNS } from "./anthropic/adapter.js";
import { mapProviderHttpError, providerFetch } from "./provider-http-error.js";

afterEach(() => vi.useRealTimers());

describe("provider retry headers", () => {
  it("parses millisecond and seconds headers", () => {
    expect(
      mapProviderHttpError({
        status: 429,
        message: "rate limited",
        headers: new Headers({ "retry-after-ms": "1250", "retry-after": "9" }),
      }),
    ).toMatchObject({ retryable: true, retryAfterMs: 1_250 });

    expect(
      mapProviderHttpError({
        status: 429,
        message: "rate limited",
        headers: { "Retry-After": "2.5" },
      }),
    ).toMatchObject({ retryable: true, retryAfterMs: 2_500 });
  });

  it("parses HTTP dates and lets x-should-retry false override classification", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T00:00:00.000Z"));
    expect(
      mapProviderHttpError({
        status: 429,
        message: "rate limited",
        response: {
          headers: new Headers({
            "retry-after": "Sat, 18 Jul 2026 00:00:03 GMT",
            "x-should-retry": "false",
          }),
        },
      }),
    ).toMatchObject({ retryable: false, retryAfterMs: 3_000 });
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
    ["OpenAI", openAI402],
    ["Anthropic", anthropic402],
  ])("does not retry a %s 402 and keeps its status, message and body", (_provider, err) => {
    const mapped = mapProviderHttpError(err);
    expect(mapped).toMatchObject({
      code: "provider_error",
      retryable: false,
      providerResponse: { status: 402, message: "Insufficient Balance" },
    });
    expect(mapped.providerResponse?.body).toContain("Insufficient Balance");
  });

  it.each([404, 409, 413, 422])("does not retry an unnamed %i", (status) => {
    expect(mapProviderHttpError({ status, message: "rejected" })).toMatchObject({
      code: "provider_error",
      retryable: false,
    });
  });

  it("still retries 408, 429, 5xx and failures without a response", () => {
    expect(mapProviderHttpError({ status: 408, message: "timed out" }).retryable).toBe(true);
    expect(mapProviderHttpError({ status: 429, message: "slow down" }).retryable).toBe(true);
    expect(mapProviderHttpError({ status: 529, message: "overloaded" })).toMatchObject({
      code: "server_error",
      retryable: true,
    });
    const offline = mapProviderHttpError(new TypeError("fetch failed"));
    expect(offline).toMatchObject({ code: "network_error", retryable: true });
    expect(offline.providerResponse).toBeUndefined();
  });

  it("keeps the exact body text an OpenAI or Anthropic providerFetch client received", async () => {
    // Spacing the SDKs' parsed view would not reproduce, so only the exact text matches.
    const body =
      '{ "error": { "message": "Insufficient Balance", "type": "unknown_error" },\n  "request_id": "r1" }';
    vi.stubGlobal("fetch", async () => new Response(body, { status: 402 }));
    try {
      const openai = new OpenAI({
        apiKey: "test",
        baseURL: "http://provider.invalid/v1",
        maxRetries: 0,
        fetch: providerFetch,
      });
      const anthropic = new Anthropic({
        apiKey: "test",
        baseURL: "http://provider.invalid",
        maxRetries: 0,
        fetch: providerFetch,
      });
      const failures = await Promise.all([
        openai.chat.completions
          .create({ model: "m", messages: [{ role: "user", content: "hi" }] })
          .catch((error: unknown) => error),
        anthropic.messages
          .create({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] })
          .catch((error: unknown) => error),
      ]);
      for (const err of failures) {
        expect(mapProviderHttpError(err)).toMatchObject({
          code: "provider_error",
          retryable: false,
          providerResponse: { status: 402, message: "Insufficient Balance", body },
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls an Anthropic 400 content_filtered only when it says filtered or blocked", () => {
    expect(
      mapProviderHttpError(
        { status: 400, message: "Output blocked by content policy" },
        ANTHROPIC_ERROR_PATTERNS,
      ).code,
    ).toBe("content_filtered");
    expect(
      mapProviderHttpError(
        { status: 400, message: "content filtering triggered" },
        ANTHROPIC_ERROR_PATTERNS,
      ).code,
    ).toBe("content_filtered");
    expect(
      mapProviderHttpError(
        { status: 400, message: "messages.0: invalid content block type" },
        ANTHROPIC_ERROR_PATTERNS,
      ).code,
    ).toBe("invalid_request");
  });

  it("caps the stored body at 4,096 characters", () => {
    const html = `<html>${"x".repeat(10_000)}</html>`;
    const mapped = mapProviderHttpError({ status: 502, message: "bad gateway", error: html });
    expect(mapped.providerResponse?.body).toHaveLength(4_096);
  });
});
