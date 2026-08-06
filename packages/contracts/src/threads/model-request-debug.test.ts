/** Shared readable and prefix projection for model-request diagnostics. */
import { describe, expect, it } from "vitest";
import {
  deriveModelRequestDebugViews,
  type ModelRequestDebugRecord,
  type ModelRequestDebugRequest,
} from "./model-request-debug.js";

function record(
  iteration: number,
  request: ModelRequestDebugRequest | null,
): ModelRequestDebugRecord {
  return {
    schema: "meridian.model-request-debug.v1",
    gatewayCallId: `call-${iteration}`,
    threadId: "thread-1",
    turnId: "turn-1",
    iteration,
    requestedAt: `2026-08-06T00:00:0${iteration}.000Z`,
    agentSlug: "writer",
    requestDigest: `digest-${iteration}`,
    requestBytes: 100,
    capture: request
      ? { status: "complete" }
      : { status: "omitted", reason: "record_too_large", maxRecordBytes: 10 },
    request,
    skills: [],
    toolRegistrations: [],
  };
}

const firstRequest: ModelRequestDebugRequest = {
  messages: [
    { role: "system", content: [{ type: "text", text: "System **Markdown**" }] },
    { role: "user", content: [{ type: "text", text: "Delete block `84c5`." }] },
  ],
  tools: [
    {
      type: "function",
      name: "write",
      description: "Edit a document",
      inputSchema: { type: "object" },
    },
  ],
};

describe("deriveModelRequestDebugViews", () => {
  it("renders the complete canonical request and detects a tool-loop prefix", () => {
    const secondRequest: ModelRequestDebugRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages,
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "tool-1",
              toolName: "write",
              input: { command: "delete", in: "84c5" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              toolCallId: "tool-1",
              output: { status: "success", deletedHashes: ["84c5"] },
            },
          ],
        },
      ],
    };

    const views = deriveModelRequestDebugViews([record(0, firstRequest), record(1, secondRequest)]);

    expect(views[0]?.prefix.status).toBe("first");
    expect(views[1]?.prefix).toEqual({
      status: "exact",
      previousRequestDigest: "digest-0",
      preservedMessageCount: 2,
    });
    expect(views[1]?.markdown).toContain("## Message 1: user");
    expect(views[1]?.markdown).toContain("Delete block `84c5`.");
    expect(views[1]?.markdown).toContain('"deletedHashes": [');
    expect(views[1]?.markdown).toContain("## Advertised tools");
  });

  it("reports changed and unavailable prefixes honestly", () => {
    const changed: ModelRequestDebugRequest = {
      ...firstRequest,
      messages: [
        ...firstRequest.messages.slice(0, 1),
        { role: "user", content: [{ type: "text", text: "Rewritten history" }] },
      ],
    };

    const changedView = deriveModelRequestDebugViews([
      record(0, firstRequest),
      record(1, changed),
    ])[1];
    expect(changedView?.prefix.status).toBe("changed");

    const omittedView = deriveModelRequestDebugViews([record(2, null)])[0];
    expect(omittedView?.prefix.status).toBe("unavailable");
    expect(omittedView?.markdown).toContain("exceeded the 10-byte capture limit");
  });
});
