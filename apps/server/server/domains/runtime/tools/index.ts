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
  type LsToolInput,
  type SearchToolInput,
  type WorkCommand,
  WorkCommandSchema,
} from "./core-tools.js";
export type { DocumentRef, DocumentTextPolicy } from "./document-text.js";
export { createInspectionToolRegistrations } from "./inspection-tools.js";
export {
  type InvalidArgumentIssue,
  type InvalidArgumentsResult,
  invalidArgumentsResult,
  renderInvalidArguments,
} from "./invalid-arguments.js";
export { type LsEntry, type LsResult, sortLsEntries } from "./ls-result.js";
export { searchPassage } from "./search-result.js";
export {
  createSkillToolRegistrations,
  readSkill,
  refuseSkillSearch,
  refuseSkillWrite,
  skillsRootEntries,
} from "./skill-tool.js";
export {
  createSpawnToolRegistrations,
  SpawnInputSchema,
  type SpawnToolArgs,
  type ThreadMessageArgs,
  type ThreadMessageMode,
  type ThreadReportArgs,
} from "./spawn-tools.js";
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
export type { ModelWork, WorkShowResult } from "./work-result.js";
