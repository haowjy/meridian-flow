/** Read-only connected-conversation tools wired with repositories at composition. */
import { type MeridianError, meridianErrorFromSystem } from "@meridian/contracts/interrupt";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import type { ThreadRepositories, ThreadStatusReader } from "../../threads/ports/repositories.js";
import type { TokenizerFamily } from "../gateway/index.js";
import { readThreadHistory, ThreadHistoryInputSchema } from "../spawn/thread-history.js";
import { listReadableThreads, ThreadLsInputSchema } from "../spawn/thread-ls.js";
import { historyDocumentText } from "./document-text.js";
import { threadHistoryPreview } from "./history-previews.js";
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
          "List connected conversations in your lineage. Defaults to this thread, with its path to the root and one level of children. depth can be 1 to 3. Use the returned cursor for older children.",
        inputSchema: modelToolSchema(ThreadLsInputSchema),
      },
      sequential: true,
      historyPreview: threadHistoryPreview,
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
            input: ThreadLsInputSchema.parse(input),
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
        description:
          "Read a connected conversation, including your own earlier history. Defaults to the newest 40 visible items. Pages stop at prompt epochs and are always chronological. include opts in to thinking, tool_args, tool_results, system_messages, or system_prompt. expand reads a position.sequence handle (or position for a turn header). Document copies are pointers; write inputs are dated edit records, not current documents.",
        inputSchema: modelToolSchema(ThreadHistoryInputSchema),
      },
      sequential: true,
      historyPreview: threadHistoryPreview,
      documentText: historyDocumentText,
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
            input: ThreadHistoryInputSchema.parse(input),
            tokenizer,
          });
          return "ok" in result && !result.ok ? toolFailureResult(result) : result;
        },
      },
    },
  ];
}
