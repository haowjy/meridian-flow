/** Writer vs Critic metadata advertise different write schemas. */
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import { createInMemoryRepositories } from "../../threads/index.js";
import { projectToolPolicy } from "../loop/permissions/project-tool-policy.js";
import { resolveAgentThreadTurnContext } from "./agent-thread-context.js";
import { type CoreToolHandlers, createCoreToolRegistrations } from "./core-tools.js";
import { createSkillToolRegistrations } from "./skill-tool.js";
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

const WRITE_MUTATE = ["create", "delete", "insert", "redo", "replace", "undo"] as const;

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

function advertisedCommands(schema: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const defs =
    schema.$defs && typeof schema.$defs === "object" && !Array.isArray(schema.$defs)
      ? (schema.$defs as Record<string, unknown>)
      : undefined;
  const unions = [
    ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
  ];
  for (const branch of unions) {
    const command = branchCommand(branch, defs);
    if (command) found.add(command);
  }
  const properties = schema.properties;
  if (properties && typeof properties === "object") {
    const command = (properties as Record<string, unknown>).command;
    if (command && typeof command === "object") {
      const commandSchema = command as Record<string, unknown>;
      if (Array.isArray(commandSchema.enum)) {
        for (const value of commandSchema.enum) {
          if (typeof value === "string") found.add(value);
        }
      }
    }
  }
  return [...found].sort();
}

function branchCommand(branch: unknown, defs: Record<string, unknown> | undefined): string | null {
  if (!branch || typeof branch !== "object") return null;
  const record = branch as Record<string, unknown>;
  if (typeof record.$ref === "string" && defs) {
    const name = record.$ref.split("/").at(-1);
    if (name && defs[name] !== undefined) return branchCommand(defs[name], defs);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    const command = (properties as Record<string, unknown>).command;
    if (command && typeof command === "object") {
      const commandSchema = command as Record<string, unknown>;
      if (typeof commandSchema.const === "string") return commandSchema.const;
      if (Array.isArray(commandSchema.enum) && typeof commandSchema.enum[0] === "string") {
        return commandSchema.enum[0];
      }
    }
  }
  return null;
}

async function boundContext(metadata: { tools?: typeof WRITER_MAP | typeof CRITIC_MAP }) {
  const projects = createInMemoryProjectRepository();
  const project = await projects.create({ userId: "user-1", title: "Serial" });
  const repos = createInMemoryRepositories({ projects });
  const thread = await repos.threads.create({ userId: "user-1", projectId: project.id });
  const registry = createToolRegistry({
    registrations: [
      ...createCoreToolRegistrations(stubHandlers()),
      ...createSkillToolRegistrations({
        async loadBody() {
          return { slug: "writing-principles", body: "body" };
        },
      }),
      ...createSpawnToolRegistrations(),
    ],
  });
  const context = await resolveAgentThreadTurnContext({
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
  return { context, registry };
}

function writeToolSchema(
  tools: { type?: string; name?: string; inputSchema?: Record<string, unknown> }[],
): Record<string, unknown> {
  const write = tools.find((tool) => tool.name === "write");
  if (!write?.inputSchema) throw new Error("write tool missing");
  return write.inputSchema;
}

describe("resolveAgentThreadTurnContext tool policy", () => {
  it("advertises Writer mutate commands on write", async () => {
    const { context, registry } = await boundContext({ tools: WRITER_MAP });
    expect(context.policy).toEqual(projectToolPolicy({ tools: WRITER_MAP }));
    expect(context.tools.map((tool) => ("name" in tool ? tool.name : tool.kind)).sort()).toEqual(
      ["ask_user", "ls", "search", "skill", "work", "write"].sort(),
    );
    expect(registry.getRegistration("spawn")?.advertise).toBe(false);
    expect(context.tools.some((tool) => "name" in tool && tool.name === "spawn")).toBe(false);
    const commands = advertisedCommands(writeToolSchema(context.tools));
    for (const command of WRITE_MUTATE) expect(commands).toContain(command);
    expect(commands).toContain("read");
    expect(commands).toContain("diff");
  });

  it("advertises Critic write as read/diff only", async () => {
    const { context } = await boundContext({ tools: CRITIC_MAP });
    expect(context.policy).toEqual(projectToolPolicy({ tools: CRITIC_MAP }));
    const commands = advertisedCommands(writeToolSchema(context.tools));
    expect(commands).toEqual(["diff", "read"]);
    for (const command of WRITE_MUTATE) expect(commands).not.toContain(command);
    expect(context.tools.some((tool) => "name" in tool && tool.name === "skill")).toBe(true);
  });
});
