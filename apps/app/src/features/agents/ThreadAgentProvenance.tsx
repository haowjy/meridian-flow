/**
 * ThreadAgentProvenance — readonly compact chip for thread header rows. Positive
 * provenance framing ("Started with …"); click-through to Library is deferred.
 */
import { t } from "@lingui/core/macro";
import type { Thread } from "@meridian/contracts/protocol";

import { useProjectAgents } from "@/client/query/useProjectAgents";

import { AgentChip } from "./AgentChip";
import { DEFAULT_AGENT_SLUG } from "./constants";
import { resolveAgentFromCatalog } from "./resolve-agent";

export function ThreadAgentProvenance({
  projectId,
  thread,
}: {
  projectId: string;
  thread: Thread | null;
}) {
  const slug = thread?.currentAgent ?? DEFAULT_AGENT_SLUG;
  const catalog = useProjectAgents(projectId);
  const agent = resolveAgentFromCatalog(slug, catalog.agents);

  return (
    <AgentChip
      variant="compact"
      agent={agent}
      tooltip={t`Started with ${agent.name}`}
      onClick={() => {
        // TODO(library): open agent detail in Library
      }}
    />
  );
}
