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
import type { CollabBranches } from "../domains/collab/index.js";
import {
  compareAgents,
  newAgentLabel,
  newAgents,
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
  /** The Agents of `level` that `owner`'s branch would make wider than live, one label each. */
  labels(input: {
    userId: string;
    projectId: string;
    owner: DraftOwner;
    level: AgentsLevel;
  }): Promise<string[]>;
  /** The check's outcome for the chat's write at `level`; `callId` makes the Apply a single command. */
  settle(input: {
    thread: { id: string; userId: string; projectId: string };
    owner: DraftOwner;
    level: AgentsLevel;
    callId: string;
    /** Whether the place lets the server Apply a write that widens nothing. */
    apply: boolean;
  }): Promise<AgentsCheck>;
}

/** A command id the same call always derives, so a resend finds its first outcome. */
function applyCommandId(callId: string): CommandId {
  const hex = createHash("sha256").update(`agents-auto-apply:${callId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}` as CommandId;
}

/** The Agents level a canonical URI is a file of, if any. */
export function agentsLevelOfUri(uri: string | null): AgentsLevel | null {
  const parsed = uri ? parseUnifiedContextUri(uri) : null;
  return parsed?.ok
    ? (agentsLocationOf(parsed.value.scheme, parsed.value.path)?.level ?? null)
    : null;
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
      widened: compareAgents(before, after).map(widenedLabel),
      created: newAgents(before, after).map(newAgentLabel),
    };
  }

  return {
    async labels({ userId, projectId, owner, level }) {
      return (await compare(userId, { projectId, level }, owner)).widened;
    },
    async settle({ thread, owner, level, callId, apply }) {
      const scope = { projectId: thread.projectId, level };
      const check = () => compare(thread.userId, scope, owner);
      if (!apply) {
        const now = await check();
        return { status: "waiting", labels: now.widened, created: now.created };
      }
      const levelOwner: AgentsLevelOwner =
        level === "project"
          ? { level, projectId: thread.projectId }
          : { level, userId: thread.userId };
      // Under the level's lock the comparison sees every earlier auto-Apply's effect, so two
      // writes that are safe alone and widen together cannot both land.
      return deps.holdLevel(levelOwner, async (): Promise<AgentsCheck> => {
        const now = await check();
        if (now.widened.length > 0)
          return { status: "waiting", labels: now.widened, created: now.created };
        const result = await deps.draftReview.autoApply({
          owner,
          accountId: thread.userId as UserId,
          projectId: thread.projectId as ProjectId,
          commandId: applyCommandId(callId),
          select: (item) => agentsLevelOfUri(item.path) === level,
        });
        return result.status === "applied"
          ? { status: "applied", created: now.created }
          : { status: "unchanged", created: now.created };
      });
    },
  };
}
