import type { ResponseAuthorship } from "@meridian/contracts";
import type {
  ModelEditKey,
  ModelEditOutcome,
  ModelEditToolResult,
} from "@meridian/contracts/drafts";
import type { McpScriptCall } from "@meridian/contracts/mcp";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type {
  ReturnResultCapture,
  ReturnResultOutcome,
  SpawnResult,
} from "@meridian/contracts/spawn";
import type { JsonObject, JsonValue, ToolContentPart } from "@meridian/contracts/threads";
import type { ModelInfo, Tool } from "@meridian-flow/runtime/gateway";
import type { z } from "zod";
import type { ResultEvidence } from "../../../shared/model-evidence.js";
import type { FrontierLookups } from "../ports/document-evidence.js";
import type { DocumentTextPolicy } from "./document-text.js";
import type { InvalidArgumentsResult } from "./invalid-arguments.js";
import type { SpawnToolArgs, ThreadMessageArgs, ThreadReportArgs } from "./spawn-tools.js";

export interface ToolCallInput {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  argumentsParseError?: { raw: string; message: string };
}

export interface ToolExecutionContext {
  threadId: ThreadId;
  turnId: TurnId;
  responseIdentity?: ResponseAuthorship;
  commandOwner?: Pick<ModelEditKey, "accountId" | "projectId">;
  agentSlug: string | null;
  signal?: AbortSignal;
  emitOutputDelta?: (
    toolCallId: string,
    chunk: { stream: "stdout" | "stderr"; text: string },
  ) => void;
  emitConnectionCall?: (
    toolCallId: string,
    event: {
      sequence: number;
      id: string;
      arguments: JsonObject;
      call?: McpScriptCall;
    },
  ) => void;
  spawn?: SpawnToolHandlerContext["spawn"];
  threadMessage?: ThreadMessageToolHandlerContext["threadMessage"];
  threadReport?: ThreadReportToolHandlerContext["threadReport"];
  returnResult?: ReturnResultToolHandlerContext["returnResult"];
  request?: RequestToolHandlerContext["request"];
  frontiers?: FrontierLookups;
  shownNames?: () => Promise<Uint8Array[]>;
  model?: ModelInfo;
}

export interface ToolExecutionResult {
  toolCallId: string;
  content: ToolContentPart[];
  isError?: boolean;
  metadata?: JsonObject;
  returnResult?: ReturnResultOutcome;
  result: JsonValue;
  evidence?: ResultEvidence;
  blockId?: string;
}

export type { ResultEvidence };

export interface ToolExecutor {
  executeTool(call: ToolCallInput, ctx: ToolExecutionContext): Promise<ToolExecutionResult>;
  getDefinitions?(): Tool[];
}

export interface ToolHandlerContext {
  signal: AbortSignal;
  toolCallId?: string;
  threadId: string;
  turnId: string;
  responseIdentity?: ResponseAuthorship;
  agentSlug: string | null;
  emitOutputDelta?: (chunk: { stream: "stdout" | "stderr"; text: string }) => void;
  emitConnectionCall?: (event: {
    sequence: number;
    id: string;
    arguments: JsonObject;
    call?: McpScriptCall;
  }) => void;
  frontiers?: FrontierLookups;
  shownNames?: () => Promise<Uint8Array[]>;
  model?: ModelInfo;
  modelEdit?: ModelEditContext;
}

export interface ModelEditContext {
  key: ModelEditKey;
  render(raw: unknown): { toolResult: ModelEditToolResult; evidence?: ResultEvidence };
}

export interface SpawnToolHandlerContext extends ToolHandlerContext {
  spawn(input: SpawnToolArgs): Promise<SpawnResult | InvalidArgumentsResult>;
}

export interface ThreadMessageToolHandlerContext extends ToolHandlerContext {
  threadMessage(input: ThreadMessageArgs): Promise<SpawnResult | InvalidArgumentsResult>;
}
export interface ThreadReportToolHandlerContext extends ToolHandlerContext {
  threadReport(
    input: ThreadReportArgs,
  ): Promise<import("@meridian/contracts/spawn").ModelThreadReportResult>;
}

export interface ReturnResultToolHandlerContext extends ToolHandlerContext {
  returnResult(capture: ReturnResultCapture): Promise<ReturnResultOutcome>;
}

export interface RequestToolHandlerContext extends ToolHandlerContext {
  request(
    request: import("../asks/ask-service.js").AskRequest,
  ): Promise<import("../asks/ask-service.js").AskRequestOutcome>;
}

export type ToolHandler<TContext extends ToolHandlerContext = ToolHandlerContext> = (
  input: unknown,
  context: TContext,
) => Promise<unknown>;

export interface ToolRegistration {
  documentText?: DocumentTextPolicy;
  historySummary?: (input: JsonObject, result: JsonValue) => string | undefined;
  historyKind?: "routine" | ((input: JsonObject) => "routine" | "receipt");
  source: "core" | "spawn" | "skill" | "mcp";
  definition: Tool;
  input: z.ZodType;
  advertise?: boolean;
  execution:
    | {
        type: "server";
        handler:
          | ToolHandler
          | ToolHandler<SpawnToolHandlerContext>
          | ToolHandler<ThreadMessageToolHandlerContext>
          | ToolHandler<ThreadReportToolHandlerContext>
          | ToolHandler<ReturnResultToolHandlerContext>
          | ToolHandler<RequestToolHandlerContext>;
      }
    | { type: "client" };
  timeoutMs?: number;
  sequential?: boolean;
  documentCommand?: true;
  capability?: "spawn" | "thread_message" | "thread_report" | "return_result" | "request";
  formatExecutionError?: (error: ToolExecutionError) => unknown;
  renderResult?: (result: JsonValue, input: JsonObject) => ToolContentPart[];
}

export interface ModelEditHandlerResult {
  modelEdit: ModelEditOutcome;
  evidence?: ResultEvidence;
}

export interface ToolExecutionError {
  kind: "arguments_parse" | "timeout" | "abort" | "exception";
  message: string;
  arguments: unknown;
}

export interface ToolRegistry {
  register(registration: ToolRegistration): void;
  getDefinitions(): Tool[];
  getRegistration(name: string): ToolRegistration | undefined;
}
