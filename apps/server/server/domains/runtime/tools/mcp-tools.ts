/** `mcp_describe` and `mcp_call`: the two fixed tools through which a chat reaches its connections' tools. */
import type { McpCallResult, McpDescribeResult } from "@meridian/contracts/mcp";
import type { JsonObject, ToolContentPart } from "@meridian/contracts/threads";
import { z } from "zod";
import type { ConnectionsPort } from "../ports/connections.js";
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
        name: "mcp_call",
        description:
          "Call a tool listed under Connections and get its reply. Describe each tool with mcp_describe before its first call; a failed call comes back with the tool's schema.",
        inputSchema: modelToolSchema(CallInputSchema),
      },
      input: CallInputSchema,
      historySummary: (_input, result) => (result as unknown as McpCallResult).outcome,
      renderResult: (result) => {
        const call = result as unknown as McpCallResult;
        return [text(call.reply?.text ?? call.message ?? ""), ...(call.reply?.media ?? [])];
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
