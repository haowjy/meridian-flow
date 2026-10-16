/** Consolidated test contracts; each block retains its original fixture scope. */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { describe as __mergedSuite, afterEach, expect, it, vi } from "vitest";
import { ANTHROPIC_ERROR_PATTERNS } from "./anthropic/adapter.js";
import {
  createStreamAccumulator,
  eventsFromAnthropicStreamEvent,
} from "./anthropic/stream-collect.js";
import { mapProviderHttpError, providerFetch } from "./provider-http-error.js";

__mergedSuite("provider-http-error.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/gateway/adapters/provider-http-error.test.ts.
  afterEach(() => vi.useRealTimers());

  __mergedSuite("provider retry headers", () => {
    it("parses millisecond and seconds headers", () => {
      expect(
        mapProviderHttpError({
          status: 429,
          message: "rate limited",
          headers: new Headers({ "retry-after-ms": "1250", "retry-after": "9" }),
        }),
      ).toMatchObject({ retryable: true, retryAfterMs: 1250 });
      expect(
        mapProviderHttpError({
          status: 429,
          message: "rate limited",
          headers: { "Retry-After": "2.5" },
        }),
      ).toMatchObject({ retryable: true, retryAfterMs: 2500 });
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
      ).toMatchObject({ retryable: false, retryAfterMs: 3000 });
    });
  });

  __mergedSuite("provider HTTP failures", () => {
    it.each([402])("does not retry an unnamed %i", (status) => {
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
      expect(offline.providerError).toBeUndefined();
    });
    it("reads the provider's message from the body an OpenAI or Anthropic providerFetch client received", async () => {
      // No `error` key: OpenAI's SDK alone would report "402 status code (no body)".
      const body = '{ "message": "Insufficient Balance", "request_id": "r1" }';
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
            providerError: { status: 402, message: "Insufficient Balance" },
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
  });
});

__mergedSuite("context-window.test.ts", () => {
  // Merged from apps/server/server/domains/runtime/gateway/adapters/context-window.test.ts.
  __mergedSuite("context window normalization", () => {
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
      expect(
        mapProviderHttpError({ status: 400, message: "max_tokens must be positive" }).code,
      ).toBe("invalid_request");
    });
    it("maps Anthropic invalid_request_error for input length plus max_tokens", () => {
      const message = "input length and max_tokens exceed context limit: 185000 + 16384 > 200000";
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
});
