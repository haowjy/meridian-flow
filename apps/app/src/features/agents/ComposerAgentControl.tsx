// @ts-nocheck
/**
 * ComposerAgentControl — wires AgentChip + AgentPicker for the composer footer.
 * Interactive only when the next send creates or binds a new thread; readonly
 * when the thread is already started.
 */
import { t } from "@lingui/core/macro";

import { useWorkbenchAgents } from "@/client/query/useWorkbenchAgents";

import { AgentChip } from "./AgentChip";
import { AgentPicker } from "./AgentPicker";
import { DEFAULT_AGENT_SLUG } from "./constants";
import { resolveAgentFromCatalog } from "./resolve-agent";

export type ComposerAgentControlProps = {
  workbenchId: string | null;
  mode: "interactive" | "readonly";
  selectedSlug: string;
  onSelectedSlugChange?: (slug: string) => void;
  compact?: boolean;
};

export function ComposerAgentControl({
  workbenchId,
  mode,
  selectedSlug,
  onSelectedSlugChange,
  compact = false,
}: ComposerAgentControlProps) {
  const catalog = useWorkbenchAgents(workbenchId);
  const slug = selectedSlug || DEFAULT_AGENT_SLUG;
  const agent = resolveAgentFromCatalog(slug, catalog.agents);
  const variant = mode === "interactive" ? "interactive" : compact ? "compact" : "readonly";

  if (mode === "interactive") {
    return (
      <AgentPicker
        status={catalog}
        selectedSlug={slug}
        onSelect={(next) => onSelectedSlugChange?.(next)}
        trigger={<AgentChip variant={compact ? "compact" : "interactive"} agent={agent} />}
      />
    );
  }

  return (
    <AgentChip
      variant={variant}
      agent={agent}
      tooltip={t`Started with ${agent.name}`}
      onClick={() => {
        // TODO(library): open agent detail in Library
      }}
    />
  );
}
