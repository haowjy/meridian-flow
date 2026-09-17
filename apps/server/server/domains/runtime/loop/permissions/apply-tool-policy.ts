/** Applies EffectiveToolPolicy to advertisement and the name+command permission gate. */

import type { Tool } from "../../gateway/index.js";
import type { EffectiveToolPolicy } from "./project-tool-policy.js";
import type { PermissionGate } from "./types.js";

export function permissionGateFromToolPolicy(
  policy: EffectiveToolPolicy,
  extraAllowed: Iterable<string> = [],
): PermissionGate {
  const allowed = new Set([...policy.tools, ...extraAllowed]);
  const writeCommands: ReadonlySet<string> = policy.writeCommands;
  const workCommands: ReadonlySet<string> = policy.workCommands;
  return {
    check(toolName, input) {
      if (!allowed.has(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is not enabled.` };
      }
      if (toolName === "write" || toolName === "work") {
        const commands = toolName === "write" ? writeCommands : workCommands;
        const command = commandName(input);
        if (command === undefined || !commands.has(command)) {
          return {
            allowed: false,
            reason:
              command === undefined
                ? `Command is not enabled for ${toolName}.`
                : `Command "${command}" is not enabled for ${toolName}.`,
          };
        }
      }
      return { allowed: true };
    },
  };
}

export function advertiseTools(baseTools: Tool[] | undefined, policy: EffectiveToolPolicy): Tool[] {
  return (baseTools ?? [])
    .filter((tool) => policy.tools.has(toolName(tool)))
    .map((tool) => {
      if (tool.type !== "function") return tool;
      if (tool.name === "write") {
        return {
          ...tool,
          inputSchema: narrowCommandSchema(tool.inputSchema, policy.writeCommands),
        };
      }
      if (tool.name === "work") {
        return {
          ...tool,
          inputSchema: narrowCommandSchema(tool.inputSchema, policy.workCommands),
        };
      }
      return tool;
    });
}

function toolName(tool: Tool): string {
  return tool.type === "function" ? tool.name : tool.kind;
}

function commandName(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : undefined;
}

function narrowCommandSchema(
  schema: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  const clone = structuredClone(schema) as Record<string, unknown>;
  const defs =
    clone.$defs && typeof clone.$defs === "object" && !Array.isArray(clone.$defs)
      ? (clone.$defs as Record<string, unknown>)
      : undefined;
  narrowNode(clone, allowed, defs);
  if (defs) {
    for (const [key, value] of Object.entries(defs)) {
      const command = branchCommand(value, defs);
      if (command && !allowed.has(command)) delete defs[key];
    }
  }
  return clone;
}

function narrowNode(
  node: unknown,
  allowed: ReadonlySet<string>,
  defs: Record<string, unknown> | undefined,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) narrowNode(item, allowed, defs);
    return;
  }
  const record = node as Record<string, unknown>;
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = record[key];
    if (Array.isArray(branches)) {
      record[key] = branches.filter((branch) => {
        const command = branchCommand(branch, defs);
        return command === null || allowed.has(command);
      });
    }
  }
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const command = (properties as Record<string, unknown>).command;
    if (command && typeof command === "object" && !Array.isArray(command)) {
      const commandSchema = command as Record<string, unknown>;
      if (Array.isArray(commandSchema.enum)) {
        commandSchema.enum = commandSchema.enum.filter(
          (value) => typeof value === "string" && allowed.has(value),
        );
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "$defs") continue;
    narrowNode(value, allowed, defs);
  }
}

function branchCommand(branch: unknown, defs: Record<string, unknown> | undefined): string | null {
  if (!branch || typeof branch !== "object") return null;
  const record = branch as Record<string, unknown>;
  if (typeof record.$ref === "string" && defs) {
    const name = record.$ref.split("/").at(-1);
    if (name && defs[name] !== undefined) return branchCommand(defs[name], defs);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const command = (properties as Record<string, unknown>).command;
    if (command && typeof command === "object" && !Array.isArray(command)) {
      const commandSchema = command as Record<string, unknown>;
      if (typeof commandSchema.const === "string") return commandSchema.const;
      if (Array.isArray(commandSchema.enum) && commandSchema.enum.length === 1) {
        const only = commandSchema.enum[0];
        if (typeof only === "string") return only;
      }
    }
  }
  return null;
}
