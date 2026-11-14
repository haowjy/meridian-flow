/**
 * The file policy (file-access §1, §3, §8): one pure function from a
 * principal and a file's facts to its access level, the term that limited it,
 * and where an agent's write lands.
 *
 *   level = min(personLevel, lifecycleCap, agentCap)
 *
 * Skill files (`skills://`) have their own rule, `skillLevel`.
 */

import { draftOwnerKey } from "@meridian/contracts";
import { type ContextUriScheme, isDraftedScheme } from "@meridian/contracts/context-uri";
import { matchAncestors } from "./ancestors.js";
import {
  type AgentChain,
  type BranchOwnerRef,
  type FileAccessDenial,
  type FileAccessLevel,
  type FileBranchOwnerFacts,
  type FileDecision,
  type FileDestination,
  type FileFacts,
  type FileNode,
  type FileWorkFacts,
  higherLevel,
  lowerLevel,
  type Principal,
  type SkillFacts,
  type WorkRef,
} from "./types.js";

/** The most any agent may do in each source, whatever its permission. */
const SOURCE_AGENT_CAPS: Readonly<Record<ContextUriScheme, FileAccessLevel>> = {
  manuscript: "edit",
  kb: "edit",
  user: "edit",
  unfiled: "edit",
  scratch: "edit",
  uploads: "read",
};

/** Whether agent writes to this source go to the Work branch in draft mode. */
export function isDrafted(scheme: ContextUriScheme): boolean {
  return isDraftedScheme(scheme);
}

/**
 * Where an agent's access to a file of this source goes: its draft-mode
 * Work's branch for a drafted source, otherwise live. People always write
 * live. List and view paths ask this per source; tool calls carry it on
 * their grant (`destinationFor`).
 */
export function sourceDestination(
  scheme: ContextUriScheme,
  branchOwner: BranchOwnerRef | null,
): FileDestination {
  return branchOwner && isDrafted(scheme)
    ? { kind: "draft", owner: branchOwner.owner, ownerHandle: branchOwner.handle }
    : { kind: "live" };
}

/** A grant on a node of the tree; v1 has only the owner's, on the project. */
export interface NodeGrant {
  node: FileNode;
  level: FileAccessLevel;
}

/**
 * Where this access reads or writes: an explicit draft target is that draft;
 * an agent in draft mode writes a drafted source's document, or creates in a
 * drafted source's folder, through its Work branch.
 */
function destinationFor(principal: Principal, facts: FileFacts): FileDestination {
  const target = facts.target;
  if (target.kind === "draft") {
    return { kind: "draft", owner: target.owner, ownerHandle: facts.branchOwner?.handle ?? null };
  }
  // A deleted document comes back live, where it was.
  if (target.kind === "restore") return { kind: "live" };
  return sourceDestination(facts.contentScheme, principal.agent?.branchOwner ?? null);
}

/** The whole decision: the destination, then the level there. */
export function decide(
  principal: Principal,
  facts: FileFacts,
  grants: readonly NodeGrant[],
): FileDecision {
  return levelAt(principal, facts, grants, destinationFor(principal, facts));
}

type Term = { cap: FileAccessLevel; limit: FileAccessDenial; work?: WorkRef };

/**
 * The level at a given destination. `confirmEdit` calls this with the
 * grant's destination, because that is where the write lands.
 */
export function levelAt(
  principal: Principal,
  facts: FileFacts,
  grants: readonly NodeGrant[],
  at: FileDestination,
): FileDecision {
  // Precedence order: the first term at the minimum names the limit.
  const terms: Term[] = [
    { cap: personLevel(facts, grants), limit: "not_found" },
    ...lifecycleTerms(facts, at),
    ...(principal.agent ? agentTerms(principal.agent.chain, facts) : []),
  ];
  const level = terms.reduce<FileAccessLevel>((min, term) => lowerLevel(min, term.cap), "edit");
  const limiting = level === "edit" ? undefined : terms.find((term) => term.cap === level);
  const discard = terms
    .filter((term) => term.limit !== "chat_frozen")
    .every((term) => term.cap === "edit");
  return {
    discard,
    level,
    limitedBy: limiting?.limit ?? null,
    archivedWork: limiting?.limit === "work_archived" ? (limiting.work ?? null) : null,
    destination: at,
  };
}

/** The highest grant on the file or any ancestor (§3.1). */
export function personLevel(facts: FileFacts, grants: readonly NodeGrant[]): FileAccessLevel {
  return matchAncestors(facts, grants).reduce<FileAccessLevel>(
    (best, grant) => higherLevel(best, grant.level),
    "none",
  );
}

/**
 * Deleted anywhere up the chain: none, except at a draft destination whose
 * draft outlived the document's own delete (`survivingDraft`, keyed on the
 * destination, never on which view supplied the facts: a writer's review list
 * reads branch views for a live destination). Its owning Work archived, or
 * deleted and not yet purged: read. A draft also takes its own owner's
 * lifecycle (§2).
 */
function lifecycleTerms(facts: FileFacts, at: FileDestination): Term[] {
  const terms: Term[] = [];
  const deleted = facts.deleted && !(at.kind === "draft" && facts.survivingDraft);
  if (facts.projectDeleted || deleted) {
    terms.push({ cap: "none", limit: "not_found" });
  }
  if (facts.ownerWork) terms.push(...workTerms(facts.ownerWork));
  if (at.kind === "draft") {
    if (!facts.branchOwner || draftOwnerKey(facts.branchOwner.owner) !== draftOwnerKey(at.owner)) {
      throw new Error(`File facts lack the branch owner ${draftOwnerKey(at.owner)}`);
    }
    terms.push(...branchOwnerTerms(facts.branchOwner));
  }
  return terms;
}

/** A lineage with no live member is read-only until a chat in it is restored. */
function branchOwnerTerms(owner: FileBranchOwnerFacts): Term[] {
  if (owner.purged) return [{ cap: "none", limit: "not_found" }];
  if (owner.owner.kind === "lineage") {
    return owner.frozen ? [{ cap: "read", limit: "chat_frozen" }] : [];
  }
  return workTerms({ id: owner.owner.workId, ...owner });
}

/** A deleted Work's files read until its purge; a write to one is refused as if it were gone. */
function workTerms(work: FileWorkFacts): Term[] {
  if (work.deleted) return [{ cap: "read", limit: "not_found" }];
  if (work.archived) {
    return [{ cap: "read", limit: "work_archived", work: { id: work.id, handle: work.handle } }];
  }
  return [];
}

/**
 * The agent term (§8): the source's cap for every agent, and each link's
 * permission against its own thread. A `read` link may edit only the scratch
 * of its thread's current Work, No Work's included. The minimum wins.
 */
function agentTerms(chain: AgentChain, facts: FileFacts): Term[] {
  const terms: Term[] = [
    { cap: SOURCE_AGENT_CAPS[facts.contentScheme], limit: "uploads_read_only" },
  ];
  for (const link of chain) {
    const ownScratch =
      facts.contentScheme === "scratch" &&
      (link.scratchOwner.scope === "lineage"
        ? facts.ownerRootThreadId === link.scratchOwner.rootThreadId
        : facts.ownerWork?.id === link.scratchOwner.workId);
    const cap = link.permission === "edit" || ownScratch ? "edit" : "read";
    terms.push({ cap, limit: "agent_read_only" });
  }
  return terms;
}

/**
 * A skill's files (`skills://<skill>/…`) as an agent sees them, judged
 * on its own thread: `read` when the binding preloads the skill or offers it
 * as `model-invocable`, or the user invoked it in this thread, otherwise
 * `none`, so an invisible skill reads as missing. Never `edit`. Only
 * model tools read `skills://`.
 */
export function skillLevel(facts: SkillFacts, skill: string): FileAccessLevel {
  const visible =
    facts.load.includes(skill) ||
    facts.invoked.includes(skill) ||
    facts.available.some((entry) => entry.slug === skill && entry.modelInvocable);
  return visible ? "read" : "none";
}
