/** Production-shaped HTTP failure coverage for the shared API boundary. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "./http-client";

afterEach(() => vi.unstubAllGlobals());

describe("HTTP failure boundary", () => {
  const structuredEnvelope = {
    code: "request_rejected",
    message: "Rejected",
    retryable: false,
    source: "system",
  };
  const cases = [
    {
      kind: "structured envelope",
      body: JSON.stringify(structuredEnvelope),
      contentType: "application/json",
      expectedPayload: structuredEnvelope,
      expectedName: "MeridianApiError",
    },
    {
      kind: "plain JSON",
      body: JSON.stringify({ message: "Rejected" }),
      contentType: "application/json",
      expectedPayload: { message: "Rejected" },
      expectedName: "HttpResponseError",
    },
    {
      kind: "plain text",
      body: "Rejected",
      contentType: "text/plain",
      expectedPayload: "Rejected",
      expectedName: "HttpResponseError",
    },
    {
      kind: "empty body",
      body: "",
      contentType: "application/json",
      expectedPayload: null,
      expectedName: "HttpResponseError",
    },
    {
      kind: "malformed JSON",
      body: "{not-json",
      contentType: "application/json",
      expectedPayload: "{not-json",
      expectedName: "HttpResponseError",
    },
  ];

  it.each(cases)("classifies a 4xx $kind response as terminal", async (testCase) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(testCase.body, {
            status: 404,
            headers: { "content-type": testCase.contentType },
          }),
        ),
      ),
    );

    const request = postJson("/api/project/project-1/context/move/scratch", {});

    await expect(request).rejects.toMatchObject({
      name: testCase.expectedName,
      status: 404,
      ...(testCase.expectedName === "HttpResponseError"
        ? { payload: testCase.expectedPayload }
        : {}),
    });
  });

  it.each(cases)("classifies a 5xx $kind response as retryable", async (testCase) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(
          new Response(testCase.body, {
            status: 503,
            headers: { "content-type": testCase.contentType },
          }),
        ),
      ),
    );

    await expect(postJson("/api/project/project-1/context/move/scratch", {})).rejects.toMatchObject(
      { name: testCase.expectedName, status: 503 },
    );
  });

  it("keeps a network failure retryable", async () => {
    const networkError = new TypeError("offline");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(networkError)),
    );

    await expect(postJson("/api/project/project-1/context/move/scratch", {})).rejects.toBe(
      networkError,
    );
  });
});
