/** One execution-knob contract across compile, resolve, patch, and provider params. */
import { invocationPatchSchema } from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import {
  createInMemoryAgentRevisionStore,
  resolveAgentConfiguration,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import { agentGatewayMetaToGenerateParams } from "../tools/agent-thread-context.js";
import { applyInvocationPatch } from "./apply-invocation-patch.js";

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
            tools: ["read", "write", "work"],
            "disallowed-tools": ["spawn"],
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
      tools: ["read", "write", "work"],
      "disallowed-tools": ["spawn"],
      effort: "xhigh",
      permission: "edit",
    });

    const patched = await applyInvocationPatch({
      baseline,
      patch: invocationPatchSchema.parse({
        model: "patched-model",
        effort: "none",
        permission: "read",
        "disallowed-tools": ["write"],
        subagents: ["critic"],
        skills: { load: ["outline"], available: [] },
      }),
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
      tools: ["read", "write", "work"],
      "disallowed-tools": ["spawn", "write"],
      effort: "none",
      permission: "read",
    });
    expect(agentGatewayMetaToGenerateParams(patched)).toEqual({
      model: "patched-model",
      reasoning: "disabled",
    });
  });
});
