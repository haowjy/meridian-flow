/**
 * Spawn primitive tools: spawn (create a child), thread_message (put a message
 * into a thread), and return_result (child-side). Handlers are thin —
 * ChildRunCoordinator owns lifecycle; these only validate input.
 */
import { type InvocationPatch, invocationPatchSchema } from "@meridian/contracts/agents";
import {
  meridianErrorFromSystem,
  meridianErrorFromTool,
  meridianErrorToJson,
} from "@meridian/contracts/interrupt";
import { returnResultCaptureSchema, type SpawnResult } from "@meridian/contracts/spawn";
import { ZodError, z } from "zod";
import { InvocationPatchError } from "../spawn/apply-invocation-patch.js";
import { spawnHistoryPreview, threadHistoryPreview } from "./history-previews.js";
import { toolFailureResult } from "./tool-executor.js";
import type {
  ReturnResultToolHandlerContext,
  SpawnToolHandlerContext,
  ThreadMessageToolHandlerContext,
  ThreadReportToolHandlerContext,
  ToolRegistration,
} from "./types.js";

const SPAWN_DESCRIPTION =
  "Run a subagent in its own thread. Prefer a named subagent from your roster; use the generic one sparingly. After starting background work, end your turn without claiming its result; its completion wakes you. Don't message a child just to wait.";
const SPAWN_DESCRIPTION_EMPTY_ROSTER =
  "Run a subagent in its own thread. You have no named subagents; spawn only when the user asks. After starting background work, end your turn without claiming its result; its completion wakes you. Don't message a child just to wait.";

export type SpawnToolArgs = {
  agent?: string;
  prompt: string;
  from?: string;
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
    ...(rec.from !== undefined && rec.from !== null ? { from: z.string().parse(rec.from) } : {}),
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

function returnResultInputError(error: ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path.length
    ? issue.path.reduce<string>(
        (path, part) =>
          typeof part === "number"
            ? `${path}[${part}]`
            : path
              ? `${path}.${String(part)}`
              : String(part),
        "",
      )
    : "input";
  if (issue?.path[0] === "artifacts") {
    return `Invalid return_result input at ${field}: expected a Meridian document URI string. ${issue.message}`;
  }
  if (issue?.path[0] === "summary") {
    return `Invalid return_result input at ${field}: expected a string.`;
  }
  if (issue?.path[0] === "payload") {
    return `Invalid return_result input at ${field}: expected a JSON value.`;
  }
  return `Invalid return_result input at ${field}: expected an object with a string summary, optional JSON payload, and optional artifacts array of Meridian document URI strings.`;
}

const THREAD_MESSAGE_DESCRIPTION = "Send a message to a thread.";

export type ThreadMessageMode = "foreground" | "background";

export type ThreadMessageArgs = {
  /** Thread handle (`pN`/`cN`); never an internal id. */
  ref: string;
  message: string;
  mode: ThreadMessageMode;
};

export type ThreadReportArgs = { ref: string; run?: number };
export function parseThreadReportArgs(input: unknown): ThreadReportArgs {
  const rec =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    ref: typeof rec.ref === "string" ? rec.ref : "",
    ...(Number.isInteger(rec.run) && Number(rec.run) > 0 ? { run: Number(rec.run) } : {}),
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
        description: "Read a subagent's latest finished report. Does not wait for a running one.",
        inputSchema: {
          type: "object",
          properties: {
            ref: { type: "string", description: "Subagent ref such as p3." },
            run: {
              type: "integer",
              minimum: 1,
              description: "An earlier run, counting from 1.",
            },
          },
          required: ["ref"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ThreadReportToolHandlerContext) => {
          const result = await ctx.threadReport(parseThreadReportArgs(input));
          return "ok" in result && !result.ok ? toolFailureResult(result) : result;
        },
      },
      sequential: true,
      capability: "thread_report",
      historyPreview: threadHistoryPreview,
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
              description: "Roster name; omit for the generic subagent.",
            },
            from: {
              type: "string",
              description:
                'Conversation ref, or "current", that the child can read with thread_history; its history is not copied in.',
            },
            prompt: { type: "string", description: "The child's task." },
            description: {
              type: "string",
              description:
                'The name the user sees in chat, 2 to 5 words naming the task, e.g. "Chapter 12 continuity check". Distinct across parallel subagents; not a sentence, agent name or pN handle.',
            },
            mode: {
              type: "string",
              enum: ["foreground", "background"],
              description:
                "foreground (default) waits for the child's report; background returns at once.",
            },
            append_system_prompt: {
              type: "string",
              description: "Extra system-prompt text for this run only.",
            },
            overrides: {
              type: "object",
              description:
                "Change this run's model, effort, tools, disallowed-tools, subagents or skills; omitted keys keep the child's own. Change model or effort only when the task needs it.",
            },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: SpawnToolHandlerContext) => {
          let args: SpawnToolArgs;
          try {
            args = parseSpawnToolArgs(input);
          } catch (error) {
            if (error instanceof ZodError) {
              return {
                ok: false,
                error: meridianErrorFromSystem(
                  "invalid_from",
                  'from must be one conversation ref or "current".',
                ),
              };
            }
            if (!(error instanceof InvocationPatchError)) throw error;
            return {
              ok: false,
              error: meridianErrorFromSystem("spawn_invocation_patch_invalid", error.message),
            };
          }
          return ctx.spawn(args);
        },
      },
      sequential: true,
      capability: "spawn",
      historyPreview: spawnHistoryPreview,
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
              description: "Thread ref such as p3 or c1.",
            },
            message: { type: "string" },
            mode: {
              type: "string",
              enum: ["foreground", "background"],
              description:
                "background (default) queues it and returns; foreground waits for a subagent in your subtree and returns its report.",
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
      historyPreview: threadHistoryPreview,
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
              description: "Meridian document URIs produced by this child.",
              items: {
                type: "string",
              },
            },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ReturnResultToolHandlerContext) => {
          const parsed = returnResultCaptureSchema.safeParse(input);
          if (!parsed.success) {
            return {
              isError: true,
              output: meridianErrorToJson(
                meridianErrorFromTool(returnResultInputError(parsed.error)),
              ),
            };
          }
          return ctx.returnResult(parsed.data);
        },
      },
      capability: "return_result",
      advertise: false,
    },
  ];
}

export type { SpawnResult };
