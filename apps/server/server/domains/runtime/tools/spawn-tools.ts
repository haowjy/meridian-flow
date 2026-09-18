/**
 * Spawn primitive tools: spawn (parent-side) and return_result (child-side).
 * Handlers are thin — ChildRunCoordinator owns lifecycle; these only validate input.
 */
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import type {
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ToolRegistration,
} from "./types.js";

const SPAWN_DESCRIPTION =
  "Run a subagent in its own thread to delegate a task. Prefer a named specialist from your subagents roster when one fits; use the generic helper (omit agent or pass an empty string) sparingly. Use mode=background for non-blocking helper checks.";
const SPAWN_DESCRIPTION_EMPTY_ROSTER = `${SPAWN_DESCRIPTION} You have no named subagents; do not spawn unless the writer asks.`;

export type SpawnToolArgs = {
  agent?: string;
  prompt: string;
  description?: string;
  mode: "foreground" | "background";
};

/** One parse for spawn tool arguments. */
export function parseSpawnToolArgs(input: unknown): SpawnToolArgs {
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    ...(typeof rec.agent === "string" ? { agent: rec.agent } : {}),
    prompt: typeof rec.prompt === "string" ? rec.prompt : "",
    ...(typeof rec.description === "string" ? { description: rec.description } : {}),
    mode: rec.mode === "background" ? "background" : "foreground",
  };
}

/** Roster-aware spawn description; the caller's binding supplies whether it has named targets. */
export function spawnToolDescription(hasNamedTargets: boolean): string {
  return hasNamedTargets ? SPAWN_DESCRIPTION : SPAWN_DESCRIPTION_EMPTY_ROSTER;
}

export function createSpawnToolRegistrations(): ToolRegistration[] {
  return [
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "spawn",
        description: SPAWN_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            agent: {
              type: "string",
              description:
                "Named subagent from your subagents roster. Omit or pass an empty string for the generic helper.",
            },
            prompt: { type: "string", description: "Task prompt for the child agent." },
            description: { type: "string", description: "Short label for the subagent thread." },
            mode: {
              type: "string",
              enum: ["foreground", "background"],
              description:
                "foreground waits for return_result; background returns immediately and posts an inline helper result when done.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: SpawnToolHandlerContext) => {
          return ctx.spawn(parseSpawnToolArgs(input));
        },
      },
      sequential: true,
      capability: "spawn",
      advertise: true,
    },
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "return_result",
        description: "Record the report and end this turn. The child chat stays open.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "Terminal summary for the parent." },
            payload: { description: "Package-defined structured result." },
            artifacts: {
              type: "array",
              description: "Promoted artifact references produced by this child.",
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ReturnResultToolHandlerContext) => {
          const args = input as {
            summary: string;
            payload?: JsonValue;
            artifacts?: ArtifactRef[];
          };
          return ctx.returnResult({
            summary: args.summary,
            payload: args.payload,
            artifacts: args.artifacts,
          });
        },
      },
      capability: "return_result",
      advertise: false,
    },
  ];
}

export type { SpawnResult };
