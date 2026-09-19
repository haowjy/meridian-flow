/** One execution-knob contract across compile, resolve, patch, and provider params. */
import type { ResolvedAgentConfiguration } from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import {
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import { projectToolPolicy } from "../loop/permissions/project-tool-policy.js";
import { agentGatewayMetaToGenerateParams } from "../tools/agent-thread-context.js";
import { applyInvocationPatch } from "./apply-invocation-patch.js";

function config(input: Partial<ResolvedAgentConfiguration> = {}): ResolvedAgentConfiguration {
  return { model: "base-model", skills: { load: [], available: [] }, namedTargets: [], ...input };
}

const noSkills = { readSource: async () => undefined };

describe("one definition across all four surfaces", () => {
  it("compiles, resolves, patches every key, and reaches provider params", async () => {
    const revisions = createInMemoryAgentRevisionStore({ threadExists: async () => true });
    const installed = await revisions.installSource({
      coordinate: "e2e/agents",
      files: {
        "mars.toml": '[package]\nname = "e2e"\n',
        "agents/muse.md": serializeMarkdownDefinition(
          {
            name: "Muse",
            model: "muse-model",
            effort: "max",
            mode: "primary",
            tools: { read: "allow", write: "deny", edit: "deny" },
            "disallowed-tools": ["bash"],
            subagents: ["critic"],
            skills: { load: ["outline"], available: ["proofread"] },
          },
          "",
        ),
        "agents/critic.md": serializeMarkdownDefinition({ name: "Critic", mode: "primary" }, ""),
        "skills/outline/SKILL.md": "---\nname: outline\n---\noutline body.\n",
        "skills/proofread/SKILL.md": "---\nname: proofread\n---\nproofread body.\n",
      },
      dependencies: {},
    });
    const muse = installed.definitions.find((entry) => entry.slug === "muse");
    const critic = installed.definitions.find((entry) => entry.slug === "critic");
    if (!muse || !critic) throw new Error("Missing e2e fixtures");

    const baseline = await resolveAgentConfiguration({
      revision: muse,
      store: revisions,
      defaultModel: "fallback-model",
    });
    expect(baseline).toEqual({
      model: "muse-model",
      skills: {
        load: [
          {
            packageRevisionId: installed.packageRevisionId,
            path: "skills/outline/SKILL.md",
            contentDigest: expect.any(String),
          },
        ],
        available: [
          {
            packageRevisionId: installed.packageRevisionId,
            path: "skills/proofread/SKILL.md",
            contentDigest: expect.any(String),
          },
        ],
      },
      namedTargets: [{ name: "critic", definitionRevisionId: critic.id }],
      tools: { read: "allow", write: "deny", edit: "deny" },
      "disallowed-tools": ["bash"],
      effort: "xhigh",
    });

    const patched = await applyInvocationPatch({
      baseline,
      patch: {
        model: "patched-model",
        effort: "none",
        tools: { shell: "allow", read: "deny" },
        "disallowed-tools": ["edit"],
        subagents: ["critic"],
        skills: { load: ["outline"], available: [] },
      },
      caller: baseline,
      store: revisions,
      packageRevisionId: installed.packageRevisionId,
    });

    expect(patched).toEqual({
      model: "patched-model",
      skills: {
        load: [
          {
            packageRevisionId: installed.packageRevisionId,
            path: "skills/outline/SKILL.md",
            contentDigest: expect.any(String),
          },
        ],
        available: [],
      },
      namedTargets: [{ name: "critic", definitionRevisionId: critic.id }],
      tools: { read: "deny", write: "deny", edit: "deny", bash: "allow" },
      "disallowed-tools": ["edit"],
      effort: "none",
    });
    expect(agentGatewayMetaToGenerateParams(patched)).toEqual({
      model: "patched-model",
      reasoning: "disabled",
    });
  });
});

describe("override alias folding and coupled merge", () => {
  it("lifts a baseline denial when a map allow targets the same tool", async () => {
    const baseline = config({
      tools: { read: "allow", edit: "deny" },
      "disallowed-tools": ["edit"],
    });
    const patched = await applyInvocationPatch({
      baseline,
      patch: { tools: { edit: "allow" } },
      caller: config(),
      store: noSkills,
      packageRevisionId: null,
    });
    expect(patched["disallowed-tools"]).not.toContain("edit");
    expect(projectToolPolicy(patched).writeCommands).toContain("replace");
  });
});
