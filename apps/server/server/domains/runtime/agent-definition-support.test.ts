/** Runtime support gates: available skills and subagent rosters are not refusals; unknown fields still are. */
import { describe, expect, it } from "vitest";
import type { CompiledAgentDefinition } from "../packages/index.js";
import {
  agentDefinitionUnsupportedReasons,
  agentExecutionUnavailableReasons,
  agentModelUnavailableReasons,
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

  it("refuses nonempty skill load", () => {
    const loaded = definition({
      skills: { load: ["writing-principles"], available: ["creative-writing-modes"] },
    });
    expect(agentDefinitionUnsupportedReasons(loaded)).toEqual([
      "Bound skill load is not available yet.",
    ]);
    expect(agentExecutionUnavailableReasons(loaded, gateway, "model-a")).toEqual([
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

  it("checks a model id against the host model list independent of a definition", () => {
    expect(agentModelUnavailableReasons(gateway, "model-a")).toEqual([]);
    expect(agentModelUnavailableReasons(gateway, "missing-model")).toEqual([
      "The Agent's configured model is unavailable.",
    ]);
  });
});
