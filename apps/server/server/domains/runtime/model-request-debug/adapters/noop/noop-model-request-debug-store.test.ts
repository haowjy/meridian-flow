/** Disabled capture must not inspect or serialize model-request content. */

import { describe, expect, it } from "vitest";
import type { GenerateRequest } from "../../../gateway/index.js";
import { createToolRegistry } from "../../../tools/index.js";
import { createNoopModelRequestDebugStore } from "./noop-model-request-debug-store.js";

describe("NoopModelRequestDebugStore", () => {
  it("discards capture input without evaluating a non-serializable request", () => {
    const request = {
      messages: [{ role: "user", content: [{ type: "custom", kind: "test.value", data: 1n }] }],
    } as unknown as GenerateRequest;

    expect(() =>
      createNoopModelRequestDebugStore().capture({
        gatewayCallId: "call-1",
        threadId: "thread-1",
        turnId: "turn-1",
        iteration: 0,
        agentSlug: "writer",
        request,
        resolvedSkills: [],
        toolRegistry: createToolRegistry(),
      }),
    ).not.toThrow();
  });
});
