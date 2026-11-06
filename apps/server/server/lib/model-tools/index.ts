/**
 * The model tools: runtime's tool registrations bound to Meridian's context,
 * collab, file-policy and thread services.
 */
import {
  createCoreToolRegistrations,
  createSkillToolRegistrations,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import { createReadHandler, createWriteHandler } from "./document-tools.js";
import { createGrepHandler } from "./grep-handler.js";
import { createLsHandler } from "./listing-tools.js";
import type { ToolWiringDeps } from "./tool-context.js";
import { createWorkHandler } from "./work-tool.js";

export { createReferenceReader } from "./reference-reader.js";
export {
  type AgentEditResponseWriteLifecycle,
  createAgentEditResponseWriteLifecycle,
} from "./response-write-lifecycle.js";
export type { ToolWiringDeps } from "./tool-context.js";

export function createModelToolRegistrations(deps: ToolWiringDeps): ToolRegistration[] {
  return [
    ...createCoreToolRegistrations({
      read: createReadHandler(deps),
      write: createWriteHandler(deps),
      work: createWorkHandler(deps),
      ls: createLsHandler(deps),
      grep: createGrepHandler(deps),
    }),
    ...createSkillToolRegistrations(deps),
  ];
}
