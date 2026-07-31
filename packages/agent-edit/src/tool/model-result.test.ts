// Verifies the versioned model-result discriminants used by durable recovery.
import { describe, expect, it } from "vitest";
import { isAgentEditResult, modelResult } from "./model-result.js";

describe("agent-edit model result", () => {
  it("accepts valid success and error results", () => {
    expect(
      isAgentEditResult(modelResult({ command: "read", status: "success", phase: "committed" })),
    ).toBe(true);
    expect(isAgentEditResult(modelResult({ command: "delete", status: "not_found" }))).toBe(true);
  });

  it("rejects states whose phase disagrees with status", () => {
    expect(
      isAgentEditResult({
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "success",
      }),
    ).toBe(false);
    expect(
      isAgentEditResult({
        schema: "meridian.agent-edit.v1",
        command: "delete",
        status: "not_found",
        phase: "staged",
      }),
    ).toBe(false);
  });

  it("rejects unknown commands and statuses", () => {
    expect(
      isAgentEditResult({
        schema: "meridian.agent-edit.v1",
        command: "overwrite",
        status: "success",
        phase: "committed",
      }),
    ).toBe(false);
    expect(
      isAgentEditResult({
        schema: "meridian.agent-edit.v1",
        command: "read",
        status: "pending",
      }),
    ).toBe(false);
  });
});
