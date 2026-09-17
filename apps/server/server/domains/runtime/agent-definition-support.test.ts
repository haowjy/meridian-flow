/** Runtime support gates: available skills are not a refusal; load, unknown fields, and subagents still are. */
import { describe, expect, it } from "vitest";
import type { CompiledAgentDefinition } from "../packages/index.js";
import {
  agentDefinitionUnavailableReasons,
  agentDefinitionUnsupportedReasons,
} from "./agent-definition-support.js";
import type { Gateway } from "./gateway/index.js";

function definition(metadata: CompiledAgentDefinition["metadata"]): CompiledAgentDefinition {
  return { schemaVersion: 1, systemPrompt: "", metadata };
}

const gateway = {
  listModels: () => [{ id: "model-a" }],
} as Pick<Gateway, "listModels">;

describe("agent definition support", () => {
  it("does not refuse nonempty available skills", () => {
    const writer = definition({
      skills: { available: ["creative-writing-modes", "writing-principles"] },
    });
    expect(agentDefinitionUnsupportedReasons(writer)).toEqual([]);
    expect(agentDefinitionUnavailableReasons(writer, gateway, "model-a")).toEqual([]);
  });

  it("refuses nonempty skill load", () => {
    const loaded = definition({
      skills: { load: ["writing-principles"], available: ["creative-writing-modes"] },
    });
    expect(agentDefinitionUnsupportedReasons(loaded)).toEqual([
      "Bound skill load is not available yet.",
    ]);
    expect(agentDefinitionUnavailableReasons(loaded, gateway, "model-a")).toEqual([
      "Bound skill load is not available yet.",
    ]);
  });

  it("allows compiled tools and disallowed-tools", () => {
    expect(
      agentDefinitionUnsupportedReasons(
        definition({
          tools: { read: "allow", write: "deny", edit: "deny", ask_user: "allow" },
          "disallowed-tools": ["bash"],
        }),
      ),
    ).toEqual([]);
  });

  it("still refuses unknown fields and nonempty subagents", () => {
    expect(agentDefinitionUnsupportedReasons(definition({ approval: "never" }))).toEqual([
      "Unsupported Agent field: approval",
    ]);
    expect(
      agentDefinitionUnavailableReasons(
        definition({ subagents: ["writer-helper"] }),
        gateway,
        "model-a",
      ),
    ).toEqual(["Bound subagent delegation is not available yet."]);
  });
});
