/**
 * Purpose: Guards the HTTP/WS error interrupt serialization seam — one failure must round-trip identically.
 */
import { describe, expect, it } from "vitest";
import {
  httpErrorInterruptBody,
  isMeridianError,
  meridianErrorFromGateway,
  meridianErrorFromWsBoundary,
  sharedErrorInterrupt,
  wsErrorInterruptPayload,
} from "./mapping.js";

describe("interrupt error serialization", () => {
  it("serializes the same gateway failure identically for HTTP and WS", () => {
    const error = meridianErrorFromGateway("provider_error", "Upstream model failed", true);

    const httpBody = httpErrorInterruptBody(error);
    const wsPayload = wsErrorInterruptPayload(error, "thread_1");

    expect(httpBody).toEqual(sharedErrorInterrupt(error));
    expect({ kind: wsPayload.kind, error: wsPayload.error }).toEqual(httpBody);
    expect(wsPayload).toMatchObject({
      type: "error",
      threadId: "thread_1",
      ...httpBody,
    });
  });

  it("maps WS boundary codes into MeridianError before serialization", () => {
    const error = meridianErrorFromWsBoundary("checkpoint_not_pending", "No pending checkpoint");
    const httpBody = httpErrorInterruptBody(error);
    const wsPayload = wsErrorInterruptPayload(error, "thread_1");

    expect(httpBody.error).toMatchObject({
      code: "checkpoint_not_pending",
      message: "No pending checkpoint",
      source: "system",
      retryable: false,
    });
    expect({ kind: wsPayload.kind, error: wsPayload.error }).toEqual(httpBody);
  });
});

describe("isMeridianError", () => {
  it("accepts a fully-shaped MeridianError and rejects partial hand-rolled objects", () => {
    const error = meridianErrorFromGateway("provider_error", "Upstream model failed", true);
    expect(isMeridianError(error)).toBe(true);
    expect(isMeridianError({ code: "tool_error", source: "tool" })).toBe(false);
    expect(isMeridianError({ code: "x", message: "x", retryable: false, source: "bogus" })).toBe(
      false,
    );
  });
});
