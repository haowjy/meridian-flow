/**
 * What an AI's write makes an Agent wider than it was, said as one label per Agent
 * (`widenedLabel`). Display only: Changes shows it on a draft (what Applying the item would
 * land), and the chat card shows it for a write that landed live in an auto-apply level. Nothing
 * here routes, holds or blocks a write.
 */
import type { DraftOwner } from "@meridian/contracts";
import { type AgentsLevel, agentsLocationOf } from "@meridian/contracts/agents";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import {
  compareAgents,
  type Widened,
  widenedLabel,
} from "../domains/packages/domain/agent-widening.js";
import type { BoundAgentCatalog } from "../domains/packages/index.js";

export interface AgentsWidening {
  /**
   * The Agents of `level` that live plus the changes of these `nodes` of `owner`'s branch would
   * make wider than live: what the writer's Apply of those changes alone would do.
   */
  widened(input: {
    userId: string;
    projectId: string;
    owner: DraftOwner;
    level: AgentsLevel;
    nodes: readonly string[];
  }): Promise<Widened[]>;
  /**
   * Reads live `levels` now and returns what reads them again once the write has landed: one
   * label per Agent that became wider than it was. A write that stayed a draft changes nothing
   * live, so it labels nothing.
   */
  watchLive(input: {
    userId: string;
    projectId: string;
    levels: readonly AgentsLevel[];
  }): Promise<() => Promise<string[]>>;
}

/** Where in an Agents level a canonical URI is, if anywhere. */
export function agentsLocationOfUri(uri: string | null) {
  const parsed = uri ? parseUnifiedContextUri(uri) : null;
  return parsed?.ok ? agentsLocationOf(parsed.value.scheme, parsed.value.path) : null;
}

/** The Agents level a canonical URI is a file of, if any. */
export function agentsLevelOfUri(uri: string | null): AgentsLevel | null {
  return agentsLocationOfUri(uri)?.level ?? null;
}

/**
 * The places of an Agents level a pending item touches: where the branch puts it and, for a
 * move, where live has it (a file moved out of a level changes the level too).
 */
export function agentsPlacesOf(
  item: Pick<DraftReviewItem, "path" | "tree">,
): Array<NonNullable<ReturnType<typeof agentsLocationOfUri>>> {
  return [item.path, item.tree?.movedFrom ?? null].flatMap((uri) => agentsLocationOfUri(uri) ?? []);
}

export function createAgentsWidening(deps: {
  catalog: Pick<BoundAgentCatalog, "effectiveAgents">;
}): AgentsWidening {
  return {
    async widened({ userId, projectId, owner, level, nodes }) {
      const scope = { projectId, level };
      const before = await deps.catalog.effectiveAgents(userId, scope);
      const after = await deps.catalog.effectiveAgents(userId, {
        ...scope,
        branch: { owner, only: nodes },
      });
      return compareAgents(before, after);
    },
    async watchLive({ userId, projectId, levels }) {
      const read = (level: AgentsLevel) =>
        deps.catalog.effectiveAgents(userId, { projectId, level });
      const before = await Promise.all(levels.map(read));
      return async () => {
        const after = await Promise.all(levels.map(read));
        return [
          ...new Set(
            after.flatMap((now, i) => compareAgents(before[i] ?? now, now).map(widenedLabel)),
          ),
        ];
      };
    },
  };
}
