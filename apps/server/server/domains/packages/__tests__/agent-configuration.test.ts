/** Named-target resolution and presence-sensitive tools/effort copy. */
import { describe, expect, it } from "vitest";
import { createInMemoryAgentRevisionStore } from "../adapters/in-memory-agent-revision-store.js";
import {
  AgentConfigurationError,
  resolveAgentDependencies,
} from "../domain/agent-configuration.js";

const store = () => createInMemoryAgentRevisionStore({ threadExists: async () => true });

describe("resolveAgentDependencies named targets", () => {
  it("allows a pickable primary as a named spawn target", async () => {
    const revisions = store();
    const installed = await revisions.installSource({
      coordinate: "launch-agents",
      files: {
        "agents/muse.md":
          "---\nname: Muse\nmode: primary\nsubagents:\n  - critic\n---\nMuse body.\n",
        "agents/critic.md": "---\nname: Critic\nmode: primary\n---\nCritic body.\n",
      },
    });
    const muse = installed.definitions.find((agent) => agent.slug === "muse");
    const critic = installed.definitions.find((agent) => agent.slug === "critic");
    if (!muse || !critic) throw new Error("Missing Muse or Critic fixture");
    await expect(resolveAgentDependencies({ revision: muse, store: revisions })).resolves.toEqual({
      skills: { load: [], available: [] },
      namedTargets: [{ name: "critic", definitionRevisionId: critic.id }],
    });
  });

  it("refuses a model-invocable false named target", async () => {
    const revisions = store();
    const installed = await revisions.installSource({
      coordinate: "launch-agents",
      files: {
        "agents/muse.md":
          "---\nname: Muse\nmode: primary\nsubagents:\n  - helper\n---\nMuse body.\n",
        "agents/helper.md":
          "---\nname: Helper\nmode: subagent\nmodel-invocable: false\n---\nHelper body.\n",
      },
    });
    const muse = installed.definitions.find((agent) => agent.slug === "muse");
    if (!muse) throw new Error("Missing Muse fixture");
    await expect(resolveAgentDependencies({ revision: muse, store: revisions })).rejects.toThrow(
      new AgentConfigurationError('Agent "helper" cannot be invoked as a child.'),
    );
  });
});

describe("resolveAgentDependencies execution fields", () => {
  it("copies tools, disallowed-tools, and effort when present", async () => {
    const revisions = store();
    const installed = await revisions.installSource({
      coordinate: "launch-agents",
      files: {
        "agents/critic.md":
          "---\nname: Critic\nmode: primary\neffort: high\ntools:\n  edit: deny\ndisallowed-tools:\n  - bash\n---\nCritic body.\n",
      },
    });
    const critic = installed.definitions.find((agent) => agent.slug === "critic");
    if (!critic) throw new Error("Missing Critic fixture");
    await expect(resolveAgentDependencies({ revision: critic, store: revisions })).resolves.toEqual(
      {
        skills: { load: [], available: [] },
        namedTargets: [],
        tools: { edit: "deny" },
        "disallowed-tools": ["bash"],
        effort: "high",
      },
    );
  });
});
