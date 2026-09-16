/** Runtime support gates: skill availability is not a refusal; unknown fields and subagents still are. */
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
