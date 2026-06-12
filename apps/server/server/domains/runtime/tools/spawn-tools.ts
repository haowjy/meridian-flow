// @ts-nocheck
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

export function createSpawnToolRegistrations(): ToolRegistration[] {
  return [
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "spawn",
        description:
          "Run a subagent to completion in an isolated thread and return its typed terminal report.",
        inputSchema: {
          type: "object",
          properties: {
            agent: { type: "string", description: "Mars agent slug; must be in caller subagents." },
            prompt: { type: "string", description: "Task prompt for the child agent." },
            description: { type: "string", description: "Short label for the subagent thread." },
          },
          required: ["agent", "prompt"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: SpawnToolHandlerContext) => {
          const args = input as { agent: string; prompt: string; description?: string };
          return ctx.spawn({
            agent: args.agent,
            prompt: args.prompt,
            description: args.description,
          });
        },
      },
      sequential: true,
      capability: "spawn",
    },
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "return_result",
        description:
          "Terminate the subagent run and hand a typed report back to the parent spawn caller.",
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
    },
  ];
}

export type { SpawnResult };
