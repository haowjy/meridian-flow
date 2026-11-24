import {
  createCoreToolRegistrations,
  createSkillToolRegistrations,
  type ToolRegistration,
} from "../../domains/runtime/index.js";
import { createReadHandler, createWriteHandler } from "./document-tools.js";
import { createGrepHandler } from "./grep-handler.js";
import { createLsHandler } from "./listing-tools.js";
import { createSaveAgentsRegistration } from "./save-agents.js";
import type { ToolWiringDeps } from "./tool-context.js";
import { createWorkHandler } from "./work-tool.js";

export { createReferenceReader } from "./reference-reader.js";
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
    createSaveAgentsRegistration(deps),
    ...createSkillToolRegistrations(deps),
  ];
}
