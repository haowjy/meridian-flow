/** Agent-edit host diagnostics expose safe identifiers without leaking failure text. */
import { describe, expect, it } from "vitest";
import { createInMemoryEventSink } from "../../observability/index.js";
import { createAgentEditObservabilityOptions } from "./agent-edit-observability.js";

describe("agent-edit unexpected write diagnostics", () => {
  it("emits a correlation-rich safe error envelope", () => {
    const sink = createInMemoryEventSink();
    const options = createAgentEditObservabilityOptions({ eventSink: sink });

    options.onUnexpectedWriteError?.({
      cause: new Error("private writer prose"),
      command: "replace",
      documentId: "document-1",
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      responseId: "response-1",
      toolUseId: "tool-1",
    });

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]).toMatchObject({
      level: "error",
      source: "collab.agent_edit",
      name: "write.failed",
      correlation: {
        threadId: "thread-1",
        turnId: "turn-1",
        documentId: "document-1",
        errorCode: "internal_error",
      },
      payload: {
        command: "replace",
        sessionId: "session-1",
        responseId: "response-1",
        toolUseId: "tool-1",
        error: { class: "Error", category: "unexpected" },
      },
    });
    expect(JSON.stringify(sink.events[0])).not.toContain("private writer prose");
  });
});
