/**
 * Gemini provider adapter: the provider-adapter port over Google's native `generateContent`
 * API through `@google/genai`. The shared stream envelope is `../provider-stream.ts`.
 *
 * Every option the SDK would read from the environment (key, Vertex mode, project, location,
 * base URL, API version) is passed explicitly, and it sends one request because `retryOptions`
 * is never set. If the machine sets both of the SDK's own key variables it prints a console
 * warning; the explicit key still wins.
 */
import { ApiError, GoogleGenAI } from "@google/genai";
import type { ProviderConfig } from "../../domain/index.js";
import type { ProviderAdapter } from "../../ports/provider-adapter.js";
import { streamProvider } from "../provider-stream.js";
import { toGeminiParams } from "./request-map.js";
import {
  buildGenerateResult,
  createStreamAccumulator,
  eventsFromGeminiChunk,
} from "./stream-collect.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

/** `RetryInfo.retryDelay` is a duration string such as "34s" or "0.5s". */
function retryDelayMs(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    const delay = (detail as { retryDelay?: unknown } | null)?.retryDelay;
    const seconds = typeof delay === "string" ? Number.parseFloat(delay) : Number.NaN;
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }
  return undefined;
}

type GoogleError = { message?: string; details?: unknown };

/** The SDK wraps a non-JSON-typed error body as `{error: {message: <the body text>}}`, so the body can be JSON inside JSON. */
function googleErrorOf(text: string): GoogleError | undefined {
  const error = (JSON.parse(text) as { error?: GoogleError }).error;
  return typeof error?.message === "string" && error.message.startsWith("{")
    ? googleErrorOf(error.message)
    : error;
}

/**
 * The SDK's `ApiError` holds the response body as a JSON string and drops the headers. This
 * gives `mapProviderHttpError` the shape the other SDKs' errors have: the status, the body's
 * message, the parsed body, and the retry hint as a header. Google answers a bad key with 400
 * (`API_KEY_INVALID`), which is an auth error.
 */
export function geminiErrorShape(err: unknown): unknown {
  if (!(err instanceof ApiError)) return err;
  try {
    const error = googleErrorOf(err.message);
    const delay = retryDelayMs(error?.details);
    const badKey =
      Array.isArray(error?.details) &&
      error.details.some((d) => (d as { reason?: unknown } | null)?.reason === "API_KEY_INVALID");
    return {
      status: badKey ? 401 : err.status,
      message: error?.message ?? err.message,
      error,
      headers: delay === undefined ? {} : { "retry-after-ms": String(delay) },
    };
  } catch {
    return err;
  }
}

export function createGeminiAdapter(config: ProviderConfig): ProviderAdapter {
  const client = new GoogleGenAI({
    // Self-hosted and mock endpoints need no key, but the SDK warns without one.
    apiKey: config.auth?.apiKey || "not-needed",
    vertexai: false,
    apiVersion: "v1beta",
    httpOptions: { baseUrl: config.baseUrl ?? DEFAULT_BASE_URL, headers: config.auth?.headers },
  });
  const providerId = config.id;

  return {
    stream(request, model, call) {
      const acc = createStreamAccumulator(model, providerId);
      return streamProvider({
        start: { type: "start", model: model.id, provider: providerId },
        signal: request.signal,
        open: () => client.models.generateContentStream(toGeminiParams(request, model, call)),
        normalizeError: geminiErrorShape,
        events: (chunk) => eventsFromGeminiChunk(chunk, acc),
        result: () => buildGenerateResult(acc),
      });
    },
  };
}
