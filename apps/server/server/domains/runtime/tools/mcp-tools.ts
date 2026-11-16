/** `mcp_describe`, `mcp_call` and `mcp_run`: the three fixed tools through which a chat reaches its connections' tools. */
import type { McpCallResult, McpDescribeResult, McpRunResult } from "@meridian/contracts/mcp";
import type { JsonObject, ToolContentPart } from "@meridian/contracts/threads";
import { z } from "zod";
import type { ConnectionsPort, ScriptLimitsPort } from "../ports/connections.js";
import { modelToolSchema } from "./model-tool-schema.js";
import type { ToolHandlerContext, ToolRegistration } from "./types.js";

const DescribeInputSchema = z
  .object({
    tools: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .describe(
        "Tool ids from the Connections list, like notes/search_notes, or a connection's name to list its tools.",
      ),
  })
  .strict();

const CallInputSchema = z
  .object({
    tool: z.string().min(1).describe("A tool's id from the Connections list: <connection>/<tool>."),
    arguments: z
      .record(z.string(), z.unknown())
      .default({})
      .describe("The tool's arguments, as its input schema says."),
  })
  .strict();

const RunInputSchema = z
  .object({
    code: z.string().min(1).describe("The JavaScript to run: the body of an async function."),
  })
  .strict();

/**
 * Teaches the call shape, what a script can use and the limits. The example's field is the PubMed
 * server's own (`abstractText`): a wrong field name filters to an empty list and no error.
 */
const runDescription = (limits: ScriptLimitsPort) =>
  `Run JavaScript that calls connection tools. The code is the body of an async function: use await, and return the value you want back, as JSON.

Call a tool with: await call("<connection>/<tool>", { ...arguments })
Read a tool's arguments with mcp_describe before you use it. A call gives back the tool's result, already parsed: an object, an array or text. If you do not know a result's fields, call the tool once with mcp_call and look: at the object and at one record in it, not only the object's keys. A wrong field name gives an empty result, not an error. A call that fails throws an Error with the server's message.

Use mcp_run when a task needs many calls, or a large result cut down. For one call, use mcp_call.

Nothing else exists: no import, require, fetch, timers or files. console.log is kept and shown after the result. Type annotations are allowed.
Limits: ${limits.wallMs / 1000} seconds, ${limits.maxCalls} calls, ${limits.maxValueBytes / 1000} KB returned.

Example:
const found = await call("pubmed/pubmed_search_articles", { query: "CRISPR base editing", maxResults: 200 });
const full = await call("pubmed/pubmed_fetch_articles", { pmids: found.pmids });
return full.articles.filter(a => a.abstractText?.includes("off-target")).map(a => ({ pmid: a.pmid, title: a.title }));`;

/** Providers refuse an empty tool result. */
const text = (value: string): ToolContentPart => ({ type: "text", text: value || '""' });

/** Both tools are caught by `ctx.responseIdentity`: a call without it was not made by a model response. */
function callerOf(ctx: ToolHandlerContext) {
  if (!ctx.responseIdentity || !ctx.toolCallId)
    throw new Error("A connection tool needs the model response that called it");
  return {
    threadId: ctx.threadId,
    turnId: ctx.turnId,
    modelResponseId: ctx.responseIdentity.modelResponseId,
    toolCallId: ctx.toolCallId,
    signal: ctx.signal,
  };
}

export function createMcpToolRegistrations(connections: ConnectionsPort): ToolRegistration[] {
  return [
    {
      source: "mcp",
      definition: {
        type: "function",
        name: "mcp_describe",
        description:
          "Read the description and input schema of tools listed under Connections, or list a connection's tools by its name. Describe each tool before its first call.",
        inputSchema: modelToolSchema(DescribeInputSchema),
      },
      input: DescribeInputSchema,
      historySummary: (_input, result) =>
        `${(result as unknown as McpDescribeResult).items?.length ?? 0} read`,
      renderResult: (result) => [text((result as unknown as McpDescribeResult).text)],
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const { result, isError } = await connections.describe(callerOf(ctx), {
            names: (input as z.output<typeof DescribeInputSchema>).tools,
          });
          return isError ? { isError: true as const, output: result } : result;
        },
      },
    },
    {
      source: "mcp",
      definition: {
        type: "function",
        name: "mcp_run",
        description: runDescription(connections.scriptLimits),
        inputSchema: modelToolSchema(RunInputSchema),
      },
      input: RunInputSchema,
      // Two scripts in one response run one after the other, and no timeout: the runner's wall limit is the limit.
      sequential: true,
      historySummary: (_input, result) => (result as unknown as McpRunResult).ended,
      renderResult: (result) => [text((result as unknown as McpRunResult).text)],
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const { result, isError } = await connections.run(callerOf(ctx), {
            code: (input as z.output<typeof RunInputSchema>).code,
            emit: (event) => ctx.emitConnectionCall?.(event),
          });
          return isError ? { isError: true as const, output: result } : result;
        },
      },
    },
    {
      source: "mcp",
      definition: {
        type: "function",
        name: "mcp_call",
        description:
          "Call a tool listed under Connections and get its reply. Describe each tool with mcp_describe before its first call; a failed call comes back with the tool's schema.",
        inputSchema: modelToolSchema(CallInputSchema),
      },
      input: CallInputSchema,
      historySummary: (_input, result) => (result as unknown as McpCallResult).outcome,
      renderResult: (result) => {
        const call = result as unknown as McpCallResult;
        const said = call.reply?.text ?? call.message ?? "";
        return [
          text(call.schema ? `${said}\n\n${call.schema}` : said),
          ...(call.reply?.media ?? []),
        ];
      },
      execution: {
        type: "server",
        handler: async (input: unknown, ctx: ToolHandlerContext) => {
          const parsed = input as z.output<typeof CallInputSchema>;
          const { result, isError } = await connections.call(callerOf(ctx), {
            id: parsed.tool,
            arguments: parsed.arguments as JsonObject,
          });
          return isError ? { isError: true as const, output: result } : result;
        },
      },
    },
  ];
}
