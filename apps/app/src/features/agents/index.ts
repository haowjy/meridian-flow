// @ts-nocheck
/**
 * features/agents — shared agent identity primitives and catalog hooks for
 * composer, thread provenance, and results attribution surfaces.
 */
export { AgentChip, type AgentChipProps, type AgentChipVariant } from "./AgentChip";
export { AgentPicker } from "./AgentPicker";
export { ComposerAgentControl } from "./ComposerAgentControl";
export { DEFAULT_AGENT_NAME, DEFAULT_AGENT_SLUG, wireAgentSlug } from "./constants";
export { initialsFromAgentName } from "./initials-mark";
export {
  type ResolvedAgentDisplay,
  resolveAgentFromCatalog,
  sourceBadgeLabel,
} from "./resolve-agent";
export { ThreadAgentProvenance } from "./ThreadAgentProvenance";
