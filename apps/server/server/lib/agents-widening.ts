/**
 * The check on an AI's write into an Agents level. The write already landed in the chat's branch
 * (an Agents place is an `ask` place for the AI, `appliesAfterCheck`); this step compares the
 * level's Agents read live with the same level read through the branch, and either Applies the
 * branch's Agents files with the writer's own Apply or leaves them pending, labelled.
 *
 * The decisive comparison runs again inside the Apply, under the level's advisory lock: two AI
 * writes that are each safe alone (a skill and the Agent that loads it) cannot both pass when
 * together they widen. A writer's own typing and Apply never take the lock and are never gated.
 */
import { createHash } from "node:crypto";
import type { CommandId, DraftOwner, ProjectId, UserId } from "@meridian/contracts";
import { type AgentsLevel, agentsLocationOf } from "@meridian/contracts/agents";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { DraftReviewItem } from "../domains/collab/domain/branch-review-items.js";
import type { CollabBranches } from "../domains/collab/index.js";
import {
  compareAgents,
  newAgentLabel,
  newAgents,
  type Widened,
  widenedLabel,
} from "../domains/packages/domain/agent-widening.js";
import type { BoundAgentCatalog } from "../domains/packages/index.js";
import type { AgentsLevelOwner } from "../shared/agents-level-lock.js";

export type AgentsCheck =
  /** The write applied to live; `created` names the Agents it introduced. */
  | { status: "applied"; created: string[] }
  /** The write stays a draft for the writer, with one label per widened Agent. */
  | { status: "waiting"; labels: string[]; created: string[] }
  /** Nothing in the branch needed applying. */
  | { status: "unchanged"; created: string[] };

export interface AgentsWidening {
  /** The Agents of `level` that `owner`'s branch would make wider than live. */
  widened(input: {
    userId: string;
    projectId: string;
    owner: DraftOwner;
    level: AgentsLevel;
  }): Promise<Widened[]>;
  /**
   * The check's outcome for the chat's write at `levels`; `callId` makes the Apply a single
   * command. A write that touches two levels (a move between a project's Agents and the
   * account's) is judged on both and applies in one Apply, or waits in both.
   */
  settle(input: {
    thread: { id: string; userId: string; projectId: string };
    owner: DraftOwner;
    levels: AgentsLevel[];
    callId: string;
    /** Whether the place lets the server Apply a write that widens nothing. */
    apply: boolean;
  }): Promise<AgentsCheck>;
}

/** A command id the same call of the same chat always derives, so a resend finds its first outcome. */
function applyCommandId(callId: string): CommandId {
  const hex = createHash("sha256").update(`agents-auto-apply:${callId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as CommandId;
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
  /** Runs `operation` holding the level's lock (`withAgentsLevelLock`). */
  holdLevel<T>(owner: AgentsLevelOwner, operation: () => Promise<T>): Promise<T>;
  draftReview: Pick<CollabBranches["draftReview"], "autoApply">;
}): AgentsWidening {
  /** Live against the branch, per `compareAgents`; the only comparison there is. */
  async function compare(
    userId: string,
    scope: { projectId: string; level: AgentsLevel },
    owner: DraftOwner,
  ) {
    const before = await deps.catalog.effectiveAgents(userId, scope);
    const after = await deps.catalog.effectiveAgents(userId, {
      ...scope,
      branch: { owner },
    });
    return {
      widened: compareAgents(before, after),
      created: newAgents(before, after).map(newAgentLabel),
    };
  }

  return {
    async widened({ userId, projectId, owner, level }) {
      return (await compare(userId, { projectId, level }, owner)).widened;
    },
    async settle({ thread, owner, levels, callId, apply }) {
      const check = async () => {
        const each = await Promise.all(
          levels.map((level) =>
            compare(thread.userId, { projectId: thread.projectId, level }, owner),
          ),
        );
        return {
          // A write that touches two levels reads each from the same branch, so both can name one Agent.
          labels: [...new Set(each.flatMap((now) => now.widened.map(widenedLabel)))],
          created: [...new Set(each.flatMap((now) => now.created))],
        };
      };
      if (!apply) {
        const now = await check();
        return { status: "waiting", ...now };
      }
      // Under the levels' locks the comparison sees every earlier auto-Apply's effect, so two
      // writes that are safe alone and widen together cannot both land. Locks are taken in one
      // order (user, then project) so two writes that touch both levels cannot wait on each other.
      const owners = [...new Set(levels)]
        .sort()
        .map(
          (level): AgentsLevelOwner =>
            level === "project"
              ? { level, projectId: thread.projectId }
              : { level, userId: thread.userId },
        );
      const held = (rest: AgentsLevelOwner[]): Promise<AgentsCheck> => {
        const [next, ...later] = rest;
        return next ? deps.holdLevel(next, () => held(later)) : applyIfSafe();
      };
      const applyIfSafe = async (): Promise<AgentsCheck> => {
        const now = await check();
        if (now.labels.length > 0) return { status: "waiting", ...now };
        const result = await deps.draftReview.autoApply({
          owner,
          accountId: thread.userId as UserId,
          projectId: thread.projectId as ProjectId,
          commandId: applyCommandId(`${thread.id}:${callId}`),
          select: (item) => agentsPlacesOf(item).some((place) => levels.includes(place.level)),
        });
        return {
          status: result.status === "applied" ? "applied" : "unchanged",
          created: now.created,
        };
      };
      return held(owners);
    },
  };
}
