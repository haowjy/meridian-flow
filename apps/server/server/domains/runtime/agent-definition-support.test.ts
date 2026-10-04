/** Runtime support gates: available skills and subagent rosters are not refusals; unknown fields still are. */
import { describe, expect, it } from "vitest";
import type { CompiledAgentDefinition } from "../packages/index.js";
import {
  agentDefinitionUnsupportedReasons,
  agentExecutionUnavailableReasons,
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
    expect(agentExecutionUnavailableReasons(writer, gateway, "model-a")).toEqual([]);
  });

  it("allows nonempty skill load", () => {
    const loaded = definition({
      skills: { load: ["writing-principles"], available: ["creative-writing-modes"] },
    });
    expect(agentDefinitionUnsupportedReasons(loaded)).toEqual([]);
    expect(agentExecutionUnavailableReasons(loaded, gateway, "model-a")).toEqual([]);
  });

  it("allows catalog tool names and refuses any other", () => {
    expect(
      agentDefinitionUnsupportedReasons(
        definition({ tools: ["read", "write"], "disallowed-tools": ["spawn"] }),
      ),
    ).toEqual([]);
    expect(
      agentDefinitionUnsupportedReasons(
        definition({ tools: ["read", "bash"], "disallowed-tools": ["grep"] }),
      ),
    ).toEqual(["Unknown tool in tools: bash", "Unknown tool in disallowed-tools: grep"]);
  });

  it("still refuses unknown fields but allows a nonempty subagent roster", () => {
    expect(agentDefinitionUnsupportedReasons(definition({ approval: "never" }))).toEqual([
      "Unsupported Agent field: approval",
    ]);
    expect(
      agentExecutionUnavailableReasons(
        definition({ subagents: ["writer-helper"] }),
        gateway,
        "model-a",
      ),
    ).toEqual([]);
  });
});
