import type {
  McpBakedConnection,
  McpCallResult,
  McpDescribeResult,
  McpRunResult,
  McpScriptCall,
} from "@meridian/contracts/mcp";
import type { JsonObject, Thread } from "@meridian/contracts/threads";

export interface ConnectionBake {
  bakedConnections: McpBakedConnection[];
  catalogue: string | null;
}

export interface ConnectionToolCaller {
  threadId: string;
  turnId: string;
  modelResponseId: string;
  toolCallId: string;
  signal: AbortSignal;
}

export interface ScriptLimitsPort {
  wallMs: number;
  maxCalls: number;
  maxValueBytes: number;
}

export interface ConnectionsPort {
  scriptLimits: ScriptLimitsPort;
  bake(thread: Thread): Promise<ConnectionBake>;
  saved(thread: Thread, baked: readonly McpBakedConnection[]): void;
  ownNameRefusal(thread: Thread, name: string): Promise<string | null>;
  callsRan: string;
  recordedCalls(
    threadId: string,
    turnIds: readonly string[],
  ): Promise<{ turnId: string; toolCallId: string; line: string }[]>;
  call(
    caller: ConnectionToolCaller,
    input: { id: string; arguments: JsonObject },
  ): Promise<{ result: McpCallResult; isError: boolean }>;
  run(
    caller: ConnectionToolCaller,
    input: {
      code: string;
      emit(event: {
        sequence: number;
        id: string;
        arguments: JsonObject;
        call?: McpScriptCall;
      }): void;
    },
  ): Promise<{ result: McpRunResult; isError: boolean }>;
  describe(
    caller: ConnectionToolCaller,
    input: { names: string[] },
  ): Promise<{ result: McpDescribeResult; isError: boolean }>;
}
