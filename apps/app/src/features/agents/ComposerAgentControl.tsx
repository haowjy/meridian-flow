/**
 * ComposerAgentControl — the composer's agent control. Interactive (opens the
 * AgentPicker) while the next send can still bind the agent; a locked/disabled
 * selector once the thread has started (agent swapping is cost-gated for now).
 */
import { t } from "@lingui/core/macro";

import { useProjectAgents } from "@/client/query/useProjectAgents";

import { AgentPicker } from "./AgentPicker";
import { AgentSelector } from "./AgentSelector";
import { DEFAULT_AGENT_SLUG } from "./constants";
import { resolveAgentFromCatalog } from "./resolve-agent";

export type ComposerAgentControlProps = {
  projectId: string | null;
  selectedSlug: string;
} & (
  | {
      mode: "interactive";
      onSelectedSlugChange: (slug: string) => void;
    }
  | {
      mode: "readonly";
      onSelectedSlugChange?: never;
    }
);

export function ComposerAgentControl({
  projectId,
  mode,
  selectedSlug,
  onSelectedSlugChange,
}: ComposerAgentControlProps) {
  const catalog = useProjectAgents(projectId);
  const slug = selectedSlug || DEFAULT_AGENT_SLUG;
  const agent = resolveAgentFromCatalog(slug, catalog.agents);

  if (mode === "interactive") {
    return (
      <AgentPicker
        status={catalog}
        selectedSlug={slug}
        onSelect={onSelectedSlugChange}
        trigger={<AgentSelector agent={agent} />}
      />
    );
  }

  return (
    <AgentSelector
      agent={agent}
      disabled
      tooltip={t`This chat stays on ${agent.name} to keep costs predictable. Swapping agents mid-chat is coming.`}
    />
  );
}
