/** HTTP failures keep their response headers, and `Retry-After` reads in either form. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMeridianApiError, postJson, retryAfterMs } from "./http-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown, headers: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers })),
  );
}

describe("http-client failures", () => {
  it("keeps the headers on a structured error, so Retry-After reaches the caller", async () => {
    respond(
      503,
      { code: "retry_pending", message: "retry_pending", retryable: true, source: "gateway" },
      { "Retry-After": "2" },
    );
    const error = await postJson("/x", {}).catch((caught: unknown) => caught);
    expect(isMeridianApiError(error)).toBe(true);
    expect(retryAfterMs(error)).toBe(2000);
  });

  it("keeps the headers on a plain error and reads an HTTP-date Retry-After", async () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    respond(503, { message: "busy" }, { "Retry-After": "Sun, 11 Oct 2026 00:00:05 GMT" });
    const error = await postJson("/x", {}).catch((caught: unknown) => caught);
    expect(retryAfterMs(error, now)).toBe(5000);
  });

  it("reads no delay when the response sent none, or an unreadable one", async () => {
    respond(503, { message: "busy" }, {});
    expect(retryAfterMs(await postJson("/x", {}).catch((caught: unknown) => caught))).toBeNull();
    respond(503, { message: "busy" }, { "Retry-After": "soon" });
    expect(retryAfterMs(await postJson("/x", {}).catch((caught: unknown) => caught))).toBeNull();
  });
});
