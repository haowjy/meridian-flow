/**
 * features/agents — shared agent catalog hooks and focused agent UI surfaces for
 * composer and picker interactions.
 */
export { AgentPicker } from "./AgentPicker";
export { AgentSelector } from "./AgentSelector";
export { ComposerAgentControl } from "./ComposerAgentControl";
export {
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SLUG,
  threadCreateAgentField,
  wireAgentSlug,
} from "./constants";
export {
  type ResolvedAgentDisplay,
  resolveAgentFromCatalog,
} from "./resolve-agent";
