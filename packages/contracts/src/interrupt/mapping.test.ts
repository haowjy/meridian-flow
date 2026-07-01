/**
 * Purpose: Guards the HTTP/WS error interrupt serialization seam — one failure must round-trip identically.
 */
import { describe, expect, it } from "vitest";
import type { Block } from "../threads/index.js";
import { interruptIdForBlock } from "../threads/interrupt-id-for-block.js";
import { componentContentForAsk } from "./builders.js";
import { type AskRequest, askInterrupt } from "./index.js";
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
    const error = meridianErrorFromWsBoundary("interrupt_not_pending", "No pending interrupt");
    const httpBody = httpErrorInterruptBody(error);
    const wsPayload = wsErrorInterruptPayload(error, "thread_1");

    expect(httpBody.error).toMatchObject({
      code: "interrupt_not_pending",
      message: "No pending interrupt",
      source: "system",
      retryable: false,
    });
    expect({ kind: wsPayload.kind, error: wsPayload.error }).toEqual(httpBody);
  });
});

describe("ask interrupt component wire contract", () => {
  it("round-trips a generic ask request through form content and interrupt lookup", () => {
    const request: AskRequest = {
      interruptId: "interrupt_generic_form",
      prompt: "Choose the chapter metadata.",
      artifacts: [],
      answerSchema: {
        type: "object",
        properties: {
          tone: { type: "string" },
          priority: { type: "number" },
        },
        required: ["tone"],
        additionalProperties: false,
      },
      recommended: { tone: "tense" },
      requiresHuman: true,
    };

    const content = componentContentForAsk(request, 120_000);
    const block: Block = {
      id: "block_generic_form",
      turnId: "turn_1",
      responseId: null,
      blockType: "custom",
      sequence: 0,
      content,
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    expect(askInterrupt(request)).toMatchObject({ kind: "ask", ask: request });
    expect(content).toMatchObject({
      kind: "form",
      interrupt: { id: "interrupt_generic_form", timeoutMs: 120_000 },
      props: {
        prompt: "Choose the chapter metadata.",
        answerSchema: request.answerSchema,
        recommended: { tone: "tense" },
        requiresHuman: true,
      },
    });
    expect(interruptIdForBlock(block)).toBe("interrupt_generic_form");
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
