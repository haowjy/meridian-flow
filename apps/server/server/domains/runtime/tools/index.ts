/**
 * Barrel: re-exports the tool registry, executor, core tool catalogue, and
 * tool execution types.
 *
 * Note: `ToolExecutorWithBatch` is exported here but is not part of the
 * `ToolExecutor` interface — it is the concrete return type of
 * `createToolExecutor` and includes the `executeTools` batch method that
 * the orchestrator relies on for parallel+sequential dispatch.
 */

export {
  type AgentThreadTurnContext,
  agentGatewayMetaToGenerateParams,
  resolveAgentThreadTurnContext,
} from "./agent-thread-context.js";
export {
  CORE_TOOL_NAMES,
  type CoreToolHandlers,
  type CoreToolName,
  createCoreToolRegistrations,
} from "./core-tools.js";
export {
  createInvokeToolRegistration,
  INVOKE_TOOL_NAME,
  type InvokeToolDeps,
  invokeFunctionToolDefinition,
  renderSkillsSystemPromptSection,
} from "./skill-tools.js";
export { createSpawnToolRegistrations } from "./spawn-tools.js";
export { createToolExecutor, type ToolExecutorWithBatch } from "./tool-executor.js";
export { createToolRegistry } from "./tool-registry.js";
export type {
  InterruptResponse,
  InterruptToolHandlerContext,
  ToolCallInput,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolExecutor,
  ToolHandler,
  ToolHandlerContext,
  ToolRegistration,
  ToolRegistry,
} from "./types.js";
