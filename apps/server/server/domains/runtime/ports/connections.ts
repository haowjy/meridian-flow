/** What the runtime asks of a writer's MCP connections: the prompt's catalogue, and the two tools. */
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
  /** Prompt text for the composed system prompt; null when the thread holds no connection. */
  catalogue: string | null;
}

/** Where a tool call came from, for the call's record. */
export interface ConnectionToolCaller {
  threadId: string;
  turnId: string;
  modelResponseId: string;
  toolCallId: string;
  signal: AbortSignal;
}

/** What a script's limits are, for the tool description: the rest are the host's own. */
export interface ScriptLimitsPort {
  wallMs: number;
  maxCalls: number;
  maxValueBytes: number;
}

export interface ConnectionsPort {
  /** The limits `mcp_run` tells the model. */
  scriptLimits: ScriptLimitsPort;
  /**
   * The connections and catalogue a prompt written now for this thread holds: the writer's own
   * for a chat, its parent's bake in effect for a subagent. Reads the stored status and waits for
   * no check.
   */
  bake(thread: Thread): Promise<ConnectionBake>;
  /** A prompt holding these connections was saved: start the checks they are due, in the background. */
  saved(thread: Thread, baked: readonly McpBakedConnection[]): void;
  /**
   * What to tell a model that called a connection's tool by the tool's own name: use `mcp_call`.
   * Null when the name is no tool of this thread's connections.
   */
  ownNameRefusal(thread: Thread, name: string): Promise<string | null>;
  /**
   * The recorded calls of these turns, one line each, for the stub a call that did not finish
   * leaves in the request: what was sent and how far it got.
   */
  /** What opens the stub of a connection call that did not finish: the rule a failed script's list states too. */
  doNotRepeat: string;
  recordedCalls(
    threadId: string,
    turnIds: readonly string[],
  ): Promise<{ turnId: string; toolCallId: string; line: string }[]>;
  call(
    caller: ConnectionToolCaller,
    input: { id: string; arguments: JsonObject },
  ): Promise<{ result: McpCallResult; isError: boolean }>;
  /** Runs the model's script; each call it makes is recorded and `emit`ted as it is sent and as it finishes. */
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
