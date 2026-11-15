/**
 * The check on an AI's write into an Agents level. The write already landed in the chat's branch
 * (an Agents place is an `ask` place for the AI, `appliesAfterCheck`). This step freezes the click
 * that would Apply what the write produced, as a writer's click is frozen (draft ids, snapshots,
 * tree revisions), compares the level's Agents live with live plus exactly that click, and either
 * dispatches that same click or leaves the items pending, labelled. A write that lands after the
 * freeze is not in the click and gets its own check; nothing else in the branch is touched.
 *
 * The freeze, comparison and Apply run under the level's advisory lock: two AI writes that are
 * each safe alone (a skill and the Agent that loads it) cannot both pass when together they
 * widen. A writer's own typing and Apply never take the lock and are never gated.
 */
import { createHash } from "node:crypto";
import type { CommandId, DraftOwner, ProjectId, UserId } from "@meridian/contracts";
import { type AgentsLevel, agentsLocationOf } from "@meridian/contracts/agents";
import { parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import type { FrozenCut } from "../domains/collab/domain/branch-auto-apply.js";
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
import type { AgentsLevelLocks, AgentsLevelOwner } from "../shared/agents-level-lock.js";

export type AgentsCheck =
  /** The write applied to live; `created` names the Agents it introduced. */
  | { status: "applied"; created: string[] }
  /**
   * The write stays a draft for the writer, with one label per widened Agent, or `note` saying
   * why when there is none (the Apply did not take it, or another check held the level).
   */
  | { status: "waiting"; labels: string[]; created: string[]; note?: string }
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
    /** Ids of the tree nodes (documents and folders) the call wrote: its candidate items. */
    nodes: readonly string[];
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
  locks: AgentsLevelLocks;
  draftReview: Pick<CollabBranches["draftReview"], "freezeApply">;
}): AgentsWidening {
  /** Live against a branch read, per `compareAgents`; the only comparison there is. */
  async function compare(
    userId: string,
    scope: { projectId: string; level: AgentsLevel },
    owner: DraftOwner,
    frozen?: FrozenCut,
  ) {
    const before = await deps.catalog.effectiveAgents(userId, scope);
    const after = await deps.catalog.effectiveAgents(userId, {
      ...scope,
      branch: { owner, ...(frozen ? { frozen } : {}) },
    });
    return {
      widened: compareAgents(before, after),
      created: newAgents(before, after).map(newAgentLabel),
    };
  }

  return {
    // What Changes would label if the writer Applied the whole branch; the check never uses it.
    async widened({ userId, projectId, owner, level }) {
      return (await compare(userId, { projectId, level }, owner)).widened;
    },
    async settle({ thread, owner, levels, nodes, callId, apply }) {
      const written = new Set(nodes);
      const owners = [...new Set(levels)]
        .sort()
        .map(
          (level): AgentsLevelOwner =>
            level === "project"
              ? { level, projectId: thread.projectId }
              : { level, userId: thread.userId },
        );
      /** Freezes what this write produced, checks live plus exactly that, and applies it if it may. */
      const checkAndApply = async (): Promise<AgentsCheck> => {
        const frozen = await deps.draftReview.freezeApply({
          owner,
          accountId: thread.userId as UserId,
          projectId: thread.projectId as ProjectId,
          commandId: applyCommandId(`${thread.id}:${callId}`),
          select: (item) =>
            written.has(item.documentId) &&
            agentsPlacesOf(item).some((place) => levels.includes(place.level)),
        });
        if (!frozen) return { status: "unchanged", created: [] };
        const each = await Promise.all(
          levels.map((level) =>
            compare(thread.userId, { projectId: thread.projectId, level }, owner, frozen.cut),
          ),
        );
        // A write that touches two levels reads each from the same click, so both can name one Agent.
        const labels = [...new Set(each.flatMap((now) => now.widened.map(widenedLabel)))];
        const created = [...new Set(each.flatMap((now) => now.created))];
        if (!apply || labels.length > 0) return { status: "waiting", labels, created };
        return (await frozen.apply()) === "applied"
          ? { status: "applied", created }
          : {
              status: "waiting",
              labels,
              created,
              note: "the Apply did not take it, so it stays in Changes",
            };
      };
      if (!apply) return checkAndApply();
      const held = await deps.locks.hold(owners, checkAndApply);
      return held.held
        ? held.value
        : {
            status: "waiting",
            labels: [],
            created: [],
            note: "another Agents change was being checked",
          };
    },
  };
}
