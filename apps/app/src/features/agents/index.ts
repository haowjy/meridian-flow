/**
 * features/agents — shared agent identity primitives and catalog hooks for
 * composer, thread provenance, and results attribution surfaces.
 */
export { AgentChip, type AgentChipProps, type AgentChipVariant } from "./AgentChip";
export { AgentPicker } from "./AgentPicker";
export { AgentSelector } from "./AgentSelector";
export { AgentSummaryCard } from "./AgentSummaryCard";
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
  sourceBadgeLabel,
} from "./resolve-agent";

export { type UseTestAgentArgs, useTestAgent } from "./use-test-agent";
