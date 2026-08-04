// Verifies the versioned model-result discriminants used by durable recovery.
import { describe, expect, it } from "vitest";
import { isAgentEditResultEnvelope } from "./model-result.js";

describe("agent-edit model result", () => {
  it("rejects states whose phase disagrees with status", () => {
    expect(
      isAgentEditResultEnvelope({
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "success",
      }),
    ).toBe(false);
    expect(
      isAgentEditResultEnvelope({
        schema: "meridian.agent-edit.v1",
        command: "delete",
        status: "not_found",
        phase: "staged",
      }),
    ).toBe(false);
  });

  it("rejects unknown commands and statuses", () => {
    expect(
      isAgentEditResultEnvelope({
        schema: "meridian.agent-edit.v1",
        command: "overwrite",
        status: "success",
        phase: "committed",
      }),
    ).toBe(false);
    expect(
      isAgentEditResultEnvelope({
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "pending",
      }),
    ).toBe(false);
  });
});
