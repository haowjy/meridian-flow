/** Test bindings preserve production's missing-binding behavior. */
import { describe, expect, it } from "vitest";
import { createTestAgentBinding } from "./test-orchestrator-deps.js";

describe("orchestrator binding fixture", () => {
  it("does not invent a revision for an unregistered thread", async () => {
    const reader = createTestAgentBinding("fixture-model");
    expect(await reader.readThreadBinding("unregistered-thread")).toBeUndefined();
  });
  it("returns a revision only for explicitly named threads", async () => {
    const reader = createTestAgentBinding("fixture-model", "Persona", () => ["bound-thread"]);
    expect((await reader.readThreadBinding("bound-thread"))?.definition.systemPrompt).toBe(
      "Persona",
    );
    expect(await reader.readThreadBinding("new-child")).toBeUndefined();
  });
});
