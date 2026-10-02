/** Read-only connected-conversation tools wired with repositories at composition. */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { z } from "zod";
import type { ThreadRepositories, ThreadStatusReader } from "../../threads/ports/repositories.js";
import type { TokenizerFamily } from "../gateway/index.js";
import { renderThreadHistoryOutput } from "../spawn/history-result.js";
import { readThreadHistory, ThreadHistoryInputSchema } from "../spawn/thread-history.js";
import { listReadableThreads, ThreadLsInputSchema } from "../spawn/thread-ls.js";
import { historyDocumentText } from "./document-text.js";
import { threadHistoryPreview, threadLsHistoryPreview } from "./history-previews.js";
import { modelToolSchema } from "./model-tool-schema.js";
import { toolFailureResult } from "./tool-executor.js";
import type { ToolHandlerContext, ToolRegistration, ToolRegistry } from "./types.js";
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
      historyPreview: threadLsHistoryPreview,
      historyKind: "routine",
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
          return typeof result !== "string" ? toolFailureResult(result) : result;
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
      historyPreview: threadHistoryPreview,
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
