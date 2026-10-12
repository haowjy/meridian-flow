/**
 * The model tools: runtime's tool registrations bound to Meridian's context,
 * collab, file-policy and thread services.
 */
import {
  type AskUserToolInput,
  interruptResolvedPropsFromAnswer,
} from "@meridian/contracts/components";
import { askRequestFromAskUser } from "@meridian/contracts/interrupt";
import {
  createCoreToolRegistrations,
  createSkillToolRegistrations,
  type InterruptToolHandlerContext,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import { createReadHandler, createWriteHandler } from "./document-tools.js";
import { createLsHandler, createSearchHandler } from "./listing-tools.js";
import type { ToolWiringDeps } from "./tool-context.js";
import { createWorkHandler } from "./work-tool.js";

export { createReferenceReader } from "./reference-reader.js";
export {
  type AgentEditResponseWriteLifecycle,
  createAgentEditResponseWriteLifecycle,
} from "./response-write-lifecycle.js";
export type { ToolWiringDeps } from "./tool-context.js";

async function askUserHandler(input: unknown, ctx: InterruptToolHandlerContext) {
  const args = input as AskUserToolInput;
  const timeoutMs = args.timeoutMs ?? ctx.interruptTimeoutMs;
  const request = askRequestFromAskUser(args, crypto.randomUUID());

  const response = await ctx.interrupt(request, timeoutMs);
  const resolvedProps = interruptResolvedPropsFromAnswer(response);
  await ctx.updateComponentBlock(request.interruptId, resolvedProps);
  return { value: resolvedProps.resolvedValue, provenance: response.provenance };
}

export function createModelToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  return [
    ...createCoreToolRegistrations({
      read: createReadHandler(deps),
      write: createWriteHandler(deps),
      work: createWorkHandler(deps),
      ls: createLsHandler(deps),
      search: createSearchHandler(deps),
      ask_user: askUserHandler,
    }),
    ...createSkillToolRegistrations(deps),
  ];
}
