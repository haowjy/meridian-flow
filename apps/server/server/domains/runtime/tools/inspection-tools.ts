/** Read-only connected-conversation tools wired with repositories at composition. */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { JsonValue, Thread } from "@meridian/contracts/threads";
import type { z } from "zod";
import type { ThreadRepositories, ThreadStatusReader } from "../../threads/ports/repositories.js";
import type { TokenizerFamily } from "../gateway/index.js";
import { renderRefusal, renderThreadHistoryOutput } from "../spawn/history-result.js";
import { readThreadHistory, ThreadHistoryInputSchema } from "../spawn/thread-history.js";
import {
  listReadableThreads,
  ThreadLsInputSchema,
  type ThreadLsResult,
} from "../spawn/thread-ls.js";
import { historyDocumentText } from "./document-text.js";
import { threadHistorySummary } from "./history-summaries.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { toolFailureResult } from "./tool-executor.js";
import type { ToolHandlerContext, ToolRegistration, ToolRegistry } from "./types.js";

/** `thread_ls` text: the listing itself, or the refusal. */
function renderThreadLsOutput(value: JsonValue): string {
  const result = value as Partial<ThreadLsResult> | null;
  return typeof result?.listing === "string" ? result.listing : renderRefusal(value);
}

export function createInspectionToolRegistrations(deps: {
  repos: ThreadRepositories;
  statusReader: ThreadStatusReader;
  registry: ToolRegistry;
  tokenizer: (caller: Thread) => Promise<TokenizerFamily | { ok: false; error: MeridianError }>;
}): ToolRegistration[] {
  return [
    {
      source: "core",
      definition: {
        type: "function",
        name: "thread_ls",
        description:
          "List connected conversations: the path from the root to ref, and ref's children.",
        inputSchema: modelToolSchema(ThreadLsInputSchema),
      },
      input: ThreadLsInputSchema,
      sequential: true,
      historySummary: threadHistorySummary,
      historyKind: "routine",
      renderResult: renderThreadLsOutput,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const caller = await deps.repos.threads.findById(ctx.threadId as ThreadId);
          if (!caller)
            return toolFailureResult({
              ok: false,
              error: meridianErrorFromSystem("thread_not_found", "Thread not found"),
            });
          const result = await listReadableThreads({
            ...deps,
            caller,
            input: input as z.output<typeof ThreadLsInputSchema>,
          });
          return "ok" in result ? toolFailureResult(result) : result;
        },
      },
    },
    {
      source: "core",
      definition: {
        type: "function",
        name: "thread_history",
        description: "Read the history of this or a connected conversation.",
        inputSchema: modelToolSchema(ThreadHistoryInputSchema),
      },
      input: ThreadHistoryInputSchema,
      sequential: true,
      historySummary: threadHistorySummary,
      historyKind: "routine",
      documentText: historyDocumentText,
      renderResult: renderThreadHistoryOutput,
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const caller = await deps.repos.threads.findById(ctx.threadId as ThreadId);
          if (!caller)
            return toolFailureResult({
              ok: false,
              error: meridianErrorFromSystem("thread_not_found", "Thread not found"),
            });
          const tokenizer = await deps.tokenizer(caller);
          if (typeof tokenizer !== "string") return toolFailureResult(tokenizer);
          const result = await readThreadHistory({
            ...deps,
            caller,
            input: input as z.output<typeof ThreadHistoryInputSchema>,
            tokenizer,
          });
          return "ok" in result && !result.ok ? toolFailureResult(result) : result;
        },
      },
    },
  ];
}
