/** Writer vs Critic metadata advertise different read/write document tool schemas. */
import {
  GENERIC_AGENT_BODY,
  GENERIC_SUBAGENT_SLUG,
  type InvocationOverlay,
} from "@meridian/contracts/agents";
import { describe, expect, it } from "vitest";
import type { AgentRevision } from "../../packages/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import type { Tool } from "../gateway/index.js";
import { resolveAgentThreadTurnContext, SUBAGENT_GUIDANCE } from "./agent-thread-context.js";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolRegistry } from "./tool-registry.js";

const WRITER_MAP = {
  read: "allow",
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  read: "allow",
  edit: "deny",
  ask_user: "allow",
} as const;

function stubHandlers(): CoreToolHandlers {
  const noop = async () => ({ ok: true });
  return {
    read: noop,
    write: noop,
    work: noop,
    ls: noop,
    search: noop,
    ask_user: noop,
  };
}

const fixtureRevision: AgentRevision = {
  id: "rev",
  packageRevisionId: "src",
  slug: "writer",
  definitionDigest: "digest",
  definition: {
    schemaVersion: 1,
    systemPrompt: "You are an agent.",
    metadata: { model: "fixture-model" },
  },
};

async function boundContext(metadata: {
  tools?: typeof WRITER_MAP | typeof CRITIC_MAP;
  definitionTools?: typeof WRITER_MAP | typeof CRITIC_MAP;
  namedTargets?: Array<{ name: string; definitionRevisionId: string }>;
  invocationOverlay?: InvocationOverlay | null;
  revision?: AgentRevision | null;
  kind?: "primary" | "subagent";
}) {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  const registry = createToolRegistry({
    registrations: [
      ...createCoreToolRegistrations(stubHandlers()),
      ...createSpawnToolRegistrations(),
    ],
  });
  const revision =
    metadata.revision === undefined
      ? {
          ...fixtureRevision,
          slug: metadata.tools === CRITIC_MAP ? "critic" : "writer",
          definition: {
            ...fixtureRevision.definition,
            metadata: { model: "fixture-model", tools: metadata.definitionTools },
          },
        }
      : metadata.revision;
  return resolveAgentThreadTurnContext({
    thread: { ...thread, kind: metadata.kind ?? "primary" },
    agentRevisions: {
      async readThreadBinding(threadId) {
        if (threadId !== thread.id) return undefined;
        return {
          revision,
          configuration: {
            model: "fixture-model",
            skills: { load: [], available: [] },
            namedTargets: metadata.namedTargets ?? [],
            ...(metadata.tools !== undefined ? { tools: metadata.tools } : {}),
          },
          invocationOverlay: metadata.invocationOverlay ?? null,
        };
      },
    },
    toolRegistry: registry,
    baseTools: registry.getDefinitions(),
  });
}

function commandConsts(tools: Tool[], name: string) {
  const tool = tools.find((candidate) => candidate.type === "function" && candidate.name === name);
  const oneOf = tool?.type === "function" ? tool.inputSchema.oneOf : undefined;
  if (!Array.isArray(oneOf)) throw new Error(`${name} tool missing oneOf`);
  return oneOf.map((branch) => {
    const command = (branch as { properties?: { command?: { const?: unknown } } }).properties
      ?.command?.const;
    if (typeof command !== "string") throw new Error(`${name} branch missing command.const`);
    return command;
  });
}

function hasTool(tools: Tool[], name: string): boolean {
  return tools.some((tool) => "name" in tool && tool.name === name);
}

function spawnDescription(tools: Tool[]): string {
  const spawn = tools.find((tool) => tool.type === "function" && tool.name === "spawn");
  if (spawn?.type !== "function") throw new Error("spawn tool missing");
  return spawn.description;
}

describe("resolveAgentThreadTurnContext tool policy", () => {
  it("advertises Critic read only and Writer read plus mutate write", async () => {
    const critic = await boundContext({ tools: CRITIC_MAP });
    const writer = await boundContext({ tools: WRITER_MAP });
    expect([...commandConsts(critic.tools, "read")].sort()).toEqual(["diff", "read"]);
    expect(hasTool(critic.tools, "write")).toBe(false);
    expect(commandConsts(writer.tools, "write")).toContain("replace");
    expect(commandConsts(writer.tools, "write")).not.toContain("read");
    expect([...commandConsts(writer.tools, "read")].sort()).toEqual(["diff", "read"]);
    expect(hasTool(critic.tools, "spawn")).toBe(true);
    expect(hasTool(writer.tools, "spawn")).toBe(true);
  });

  it("advertises a generic child's inherited Critic execution, not General's absent tools", async () => {
    const generic = await boundContext({ tools: CRITIC_MAP, definitionTools: WRITER_MAP });
    expect([...commandConsts(generic.tools, "read")].sort()).toEqual(["diff", "read"]);
    expect(hasTool(generic.tools, "write")).toBe(false);
  });

  it("tells an empty-roster caller not to spawn, and a rostered caller to prefer named", async () => {
    const empty = await boundContext({ tools: WRITER_MAP });
    const rostered = await boundContext({
      tools: WRITER_MAP,
      namedTargets: [{ name: "critic", definitionRevisionId: "critic-rev" }],
    });
    expect(spawnDescription(empty.tools)).toContain("do not spawn unless the writer asks");
    expect(spawnDescription(rostered.tools)).not.toContain("do not spawn unless the writer asks");
    expect(spawnDescription(rostered.tools)).toContain("Prefer a named specialist");
    expect(spawnDescription(rostered.tools)).not.toContain("Named subagents: critic.");
    expect(spawnDescription(rostered.tools)).not.toContain("critic");
  });

  it("keeps the agent body immutable and exposes the overlay as an additive layer", async () => {
    const overridden = await boundContext({
      tools: WRITER_MAP,
      invocationOverlay: { appendSystemPrompt: "Appended prompt." },
    });
    expect(overridden.agentBody).toBe("You are an agent.");
    expect(overridden.appendPrompt).toBe("Appended prompt.");

    const inherited = await boundContext({ tools: WRITER_MAP });
    expect(inherited.agentBody).toBe("You are an agent.");
    expect(inherited.appendPrompt).toBeUndefined();
    expect(inherited.subagentGuidance).toBeUndefined();

    const generic = await boundContext({ revision: null, kind: "subagent", tools: CRITIC_MAP });
    expect(generic.agentSlug).toBe(GENERIC_SUBAGENT_SLUG);
    expect(generic.agentBody).toBe(GENERIC_AGENT_BODY);
    expect(generic.subagentGuidance).toBe(SUBAGENT_GUIDANCE);

    const overriddenGeneric = await boundContext({
      revision: null,
      kind: "subagent",
      tools: CRITIC_MAP,
      invocationOverlay: { appendSystemPrompt: "Appended child prompt." },
    });
    expect(overriddenGeneric.agentSlug).toBe(GENERIC_SUBAGENT_SLUG);
    expect(overriddenGeneric.agentBody).toBe(GENERIC_AGENT_BODY);
    expect(overriddenGeneric.appendPrompt).toBe("Appended child prompt.");
  });
});
