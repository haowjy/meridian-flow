/**
 * Spawn primitive tools: spawn (create a child), thread_message (put a message
 * into a thread), and return_result (child-side). Handlers are thin —
 * ChildRunCoordinator owns lifecycle; these only validate input.
 */
import { type InvocationPatch, invocationPatchSchema } from "@meridian/contracts/agents";
import type { ArtifactRef } from "@meridian/contracts/interrupt";
import { meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { SpawnResult } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import { ZodError } from "zod";
import { InvocationPatchError } from "../spawn/apply-invocation-patch.js";
import type {
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ThreadMessageToolHandlerContext,
  ThreadReportToolHandlerContext,
  ToolRegistration,
} from "./types.js";

const SPAWN_DESCRIPTION =
  "Run a subagent in its own thread to delegate a task. Prefer a named specialist from your subagents roster when one fits; use the generic subagent (omit agent or pass an empty string) sparingly. Use mode=background for non-blocking subagent checks. After starting background work, end your turn to wait; its completion message will wake you. Do not message the child to wait or promise completion in this response.";
const SPAWN_DESCRIPTION_EMPTY_ROSTER = `${SPAWN_DESCRIPTION} You have no named subagents; do not spawn unless the writer asks.`;

export type SpawnToolArgs = {
  agent?: string;
  prompt: string;
  description?: string;
  mode: "foreground" | "background";
  append_system_prompt?: string;
  overrides?: InvocationPatch;
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
    ...(typeof rec.append_system_prompt === "string"
      ? { append_system_prompt: rec.append_system_prompt }
      : {}),
    ...(rec.overrides !== null && typeof rec.overrides === "object" && !Array.isArray(rec.overrides)
      ? { overrides: parseInvocationPatch(rec.overrides) }
      : {}),
  };
}

function parseInvocationPatch(input: unknown): InvocationPatch {
  try {
    return invocationPatchSchema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InvocationPatchError(
        error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      );
    }
    throw error;
  }
}

/** Roster-aware spawn description; the caller's binding supplies whether it has named targets. */
export function spawnToolDescription(hasNamedTargets: boolean): string {
  return hasNamedTargets ? SPAWN_DESCRIPTION : SPAWN_DESCRIPTION_EMPTY_ROSTER;
}

const THREAD_MESSAGE_DESCRIPTION =
  "Send a message to a thread. ref is the thread handle (for example p3 for a subagent, c1 for a primary) from a spawn/thread_message result. Omitted mode is background: the message is queued and returns immediately, and no reply is pushed back. Use mode=foreground to wait for a subagent in your subtree to finish and return its report. If you started background work, end your turn to wait; its completion message wakes you. Do not send a message to the child just to wait for its completion.";

export type ThreadMessageMode = "foreground" | "background";

export type ThreadMessageArgs = {
  /** Thread handle (`pN`/`cN`); never an internal id. */
  ref: string;
  message: string;
  mode: ThreadMessageMode;
};

export type ThreadReportArgs = { ref: string; execution: string };
export function parseThreadReportArgs(input: unknown): ThreadReportArgs {
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    ref: typeof rec.ref === "string" ? rec.ref : "",
    execution: typeof rec.execution === "string" ? rec.execution : "",
  };
}

/** One parse for thread_message arguments; omitted mode is background. */
export function parseThreadMessageArgs(input: unknown): ThreadMessageArgs {
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    ref: typeof rec.ref === "string" ? rec.ref : "",
    message: typeof rec.message === "string" ? rec.message : "",
    mode: rec.mode === "foreground" ? "foreground" : "background",
  };
}

export function createSpawnToolRegistrations(): ToolRegistration[] {
  return [
    {
      source: "spawn",
      definition: {
        type: "function",
        name: "thread_report",
        description:
          "Read one exact saved execution report from a child in your lineage. Use the pN ref and assistant execution UUID supplied when that execution was admitted or in its completion message. This does not wait for an active execution.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Authorized child thread handle, for example p3." },
            execution: {
              type: "string",
              description: "Exact assistant-turn UUID for the execution to retrieve.",
            },
          },
          required: ["ref", "execution"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ThreadReportToolHandlerContext) =>
          ctx.threadReport(parseThreadReportArgs(input)),
      },
      sequential: true,
      capability: "thread_report",
      advertise: true,
    },
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
                "Named subagent from your subagents roster. Omit or pass an empty string for the generic subagent.",
            },
            prompt: { type: "string", description: "Task prompt for the child agent." },
            description: { type: "string", description: "Short label for the subagent thread." },
            mode: {
              type: "string",
              enum: ["foreground", "background"],
              description: "foreground waits for the child; background returns immediately.",
            },
            append_system_prompt: {
              type: "string",
              description:
                "Appends to this child's system prompt for this invocation only; omit to add nothing.",
            },
            overrides: {
              type: "object",
              description:
                "Per-invocation execution patch: model, effort, tools, disallowed-tools, subagents, skills. Omitted fields inherit the child's saved configuration.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: SpawnToolHandlerContext) => {
          try {
            return await ctx.spawn(parseSpawnToolArgs(input));
          } catch (error) {
            if (!(error instanceof InvocationPatchError)) throw error;
            return {
              ok: false,
              error: meridianErrorFromSystem("spawn_invocation_patch_invalid", error.message),
            };
          }
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
        name: "thread_message",
        description: THREAD_MESSAGE_DESCRIPTION,
        inputSchema: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description:
                "Thread handle from a spawn/thread_message result, for example p3 or c1.",
            },
            message: { type: "string", description: "Message to deliver to the thread." },
            mode: {
              type: "string",
              enum: ["foreground", "background"],
              description:
                "background (default) queues the message and returns immediately with no pushed reply; foreground waits for a subagent in your subtree and returns its report.",
            },
          },
          required: ["ref", "message"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ThreadMessageToolHandlerContext) => {
          return ctx.threadMessage(parseThreadMessageArgs(input));
        },
      },
      sequential: true,
      capability: "thread_message",
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
