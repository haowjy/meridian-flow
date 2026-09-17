/** Writer vs Critic metadata advertise different write schemas. */
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import type { Tool } from "../gateway/index.js";
import { resolveAgentThreadTurnContext } from "./agent-thread-context.js";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createSpawnToolRegistrations } from "./spawn-tools.js";
import { createToolRegistry } from "./tool-registry.js";

const WRITER_MAP = {
  read: "allow",
  write: "allow",
  edit: "allow",
  ask_user: "allow",
} as const;

const CRITIC_MAP = {
  read: "allow",
  write: "deny",
  edit: "deny",
  ask_user: "allow",
} as const;

function stubHandlers(): CoreToolHandlers {
  const noop = async () => ({ ok: true });
  return {
    write: noop,
    work: noop,
    ls: noop,
    search: noop,
    ask_user: noop,
  };
}

async function boundContext(metadata: { tools?: typeof WRITER_MAP | typeof CRITIC_MAP }) {
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
  return resolveAgentThreadTurnContext({
    thread,
    agentRevisions: {
      async readThreadBinding(threadId) {
        if (threadId !== thread.id) return undefined;
        return {
          id: "rev",
          packageRevisionId: "src",
          slug: metadata.tools === CRITIC_MAP ? "critic" : "writer",
          definitionDigest: "digest",
          configuration: {
            model: "fixture-model",
            skills: { load: [], available: [] },
            namedTargets: [],
          },
          definition: {
            schemaVersion: 1,
            systemPrompt: "You are an agent.",
            metadata: { model: "fixture-model", ...metadata },
          },
        };
      },
    },
    toolRegistry: registry,
    baseTools: registry.getDefinitions(),
  });
}

function writeCommandConsts(tools: Tool[]) {
  const write = tools.find((tool) => tool.type === "function" && tool.name === "write");
  const oneOf = write?.type === "function" ? write.inputSchema.oneOf : undefined;
  if (!Array.isArray(oneOf)) throw new Error("write tool missing oneOf");
  return oneOf.map((branch) => {
    const command = (branch as { properties?: { command?: { const?: unknown } } }).properties
      ?.command?.const;
    if (typeof command !== "string") throw new Error("write branch missing command.const");
    return command;
  });
}

describe("resolveAgentThreadTurnContext tool policy", () => {
  it("advertises Critic write as diff/read, Writer replace, and no spawn", async () => {
    const critic = await boundContext({ tools: CRITIC_MAP });
    const writer = await boundContext({ tools: WRITER_MAP });
    expect([...writeCommandConsts(critic.tools)].sort()).toEqual(["diff", "read"]);
    expect(writeCommandConsts(writer.tools)).toContain("replace");
    expect(critic.tools.some((tool) => "name" in tool && tool.name === "spawn")).toBe(false);
    expect(writer.tools.some((tool) => "name" in tool && tool.name === "spawn")).toBe(false);
  });
});
