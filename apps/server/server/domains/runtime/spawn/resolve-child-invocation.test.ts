/**
 * Invocation resolution contracts: named roster selection (including primary
 * mode), the generic omitted/empty-agent subagent inheriting caller config,
 * overlay construction, and the pre-creation authority/availability refusals.
 * Resolution only — no thread is created here.
 */
import type { InvocationPatch } from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import { InMemoryTransactionOwner } from "../../../shared/in-memory-transaction.js";
import {
  createInMemoryAgentRevisionStore,
  seedGeneralAgent,
  serializeMarkdownDefinition,
} from "../../packages/index.js";
import {
  type ResolveChildInvocationDeps,
  resolveChildInvocation,
} from "./resolve-child-invocation.js";

async function fixture() {
  const revisions = createInMemoryAgentRevisionStore({
    transactionOwner: new InMemoryTransactionOwner(),
    threadExists: async () => true,
  });
  await seedGeneralAgent(revisions, "general-model");

  const installed = await revisions.installSource({
    coordinate: "test/agents",
    files: {
      "mars.toml": '[package]\nname = "test-agents"\n',
      "agents/critic.md": serializeMarkdownDefinition(
        {
          name: "Critic",
          model: "critic-model",
          mode: "primary",
          tools: { read: "allow", edit: "deny", ask_user: "allow" },
        },
        "You are Critic.",
      ),
      "agents/hidden.md": serializeMarkdownDefinition(
        { name: "Hidden", model: "hidden-model", "model-invocable": false },
        "",
      ),
    },
    dependencies: {},
  });
  const critic = installed.definitions.find((entry) => entry.slug === "critic");
  const hidden = installed.definitions.find((entry) => entry.slug === "hidden");
  if (!critic || !hidden) throw new Error("Missing installed test agents");

  const parentInstalled = await revisions.installSource({
    coordinate: "test/parent",
    files: {
      "mars.toml": '[package]\nname = "test-parent"\n',
      "agents/parent.md": serializeMarkdownDefinition(
        { name: "Parent", model: "parent-model", effort: "high", tools: { read: "allow" } },
        "",
      ),
    },
    dependencies: {},
  });
  const parentRevision = parentInstalled.definitions[0];
  if (!parentRevision) throw new Error("Missing parent revision");

  const parentConfiguration = {
    model: "parent-model",
    skills: { load: [], available: [] },
    namedTargets: [
      { name: "critic", definitionRevisionId: critic.id },
      { name: "hidden", definitionRevisionId: hidden.id },
    ],
    tools: { read: "allow", edit: "deny" } as const,
    effort: "high" as const,
  };
  await revisions.bindThread("parent-thread", parentRevision.id, parentConfiguration, null);
  const parentAgent = await revisions.readThreadBinding("parent-thread");
  if (!parentAgent) throw new Error("Missing parent binding");

  const deps: ResolveChildInvocationDeps = {
    agentRevisions: revisions,
    defaultModel: () => "parent-model",
    unavailableReasons: () => [],
    modelUnavailable: (model) =>
      model === "parent-model" ? [] : ["The Agent's configured model is unavailable."],
  };
  return { revisions, parentAgent, parentConfiguration, deps };
}

describe("resolveChildInvocation", () => {
  it("selects the generic child and inherits the caller configuration", async () => {
    const { parentAgent, parentConfiguration, deps } = await fixture();
    const outcome = await resolveChildInvocation({ parentAgent, requestedSlug: "" }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision).toBeNull();
    expect(outcome.resolvedSlug).toBe("subagent");
    expect(outcome.defaultTitle).toBe("subagent");
    expect(outcome.configuration.model).toBe("parent-model");
    expect(outcome.configuration.tools).toEqual(parentConfiguration.tools);
    expect(outcome.invocationOverlay).toBeNull();
  });

  it("resolves a named rostered target, including a primary", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation({ parentAgent, requestedSlug: "critic" }, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.revision?.slug).toBe("critic");
    expect(outcome.resolvedSlug).toBe("critic");
    expect(outcome.defaultTitle).toBe("critic subagent");
    expect(outcome.configuration.model).toBe("critic-model");
  });

  it("refuses a slug that is not on the caller's roster", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation(
      { parentAgent, requestedSlug: "writer-helper" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spawn_agent_not_allowed");
  });

  it("refuses a rostered target that is not model-invocable", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation({ parentAgent, requestedSlug: "hidden" }, deps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spawn_agent_not_found");
  });

  it("builds the overlay from exactly the fields present", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation(
      {
        parentAgent,
        requestedSlug: "",
        appendSystemPrompt: "Custom child prompt",
        overrides: { effort: "low" },
      },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.invocationOverlay).toEqual({
      appendSystemPrompt: "Custom child prompt",
      overrides: { effort: "low" },
    });
    expect(outcome.configuration.effort).toBe("low");
  });

  it("refuses an out-of-scope tool grant", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation(
      {
        parentAgent,
        requestedSlug: "",
        overrides: { tools: { edit: "allow" } } satisfies InvocationPatch,
      },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spawn_invocation_authority_denied");
  });

  it("refuses a malformed patch", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation(
      {
        parentAgent,
        requestedSlug: "",
        overrides: { effort: "bananas" } as unknown as InvocationPatch,
      },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spawn_invocation_patch_invalid");
  });

  it("refuses an agentless child whose overridden model is unavailable", async () => {
    const { parentAgent, deps } = await fixture();
    const outcome = await resolveChildInvocation(
      { parentAgent, requestedSlug: "", overrides: { model: "bogus-model" } },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("spawn_agent_unavailable");
  });
});
