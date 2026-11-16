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
import type { AiWriteMode } from "@meridian/contracts/works";
import { matchAncestors } from "./ancestors.js";
import {
  type AgentChain,
  type AiAccess,
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

/**
 * The most any agent may do in a source, whatever its permission, and the reason it is told. A
 * source with no entry is capped at nothing.
 */
const SOURCE_AGENT_LIMITS: Readonly<
  Partial<Record<ContextUriScheme, { cap: FileAccessLevel; limit: "uploads_read_only" }>>
> = {
  uploads: { cap: "read", limit: "uploads_read_only" },
};

/** Whether agent writes to this source go to the Work branch in draft mode. */
export function isDrafted(scheme: ContextUriScheme): boolean {
  return isDraftedScheme(scheme);
}

/**
 * The AI access of a source's places that no stored setting names: the floor `placeAccess` falls
 * back to, evaluated last. Empty: every place auto-applies. A source's rule is a row here.
 */
const FIXED_AI_ACCESS: Readonly<Partial<Record<ContextUriScheme, AiAccess>>> = {};

/**
 * What the AI may do with a write to this file: the nearest stored setting on its live folder
 * chain, else its source's fixed rule, else `auto-apply`. `ask` on a source that can't hold a
 * draft would land live without the review it asks for, so it denies.
 */
export function placeAccess(facts: FileFacts): AiAccess {
  const access =
    facts.aiAccessSettings?.[0]?.access ?? FIXED_AI_ACCESS[facts.contentScheme] ?? "auto-apply";
  return access === "ask" && !isDrafted(facts.contentScheme) ? "deny" : access;
}

function destinationAt(
  writeMode: AiWriteMode,
  access: AiAccess,
  scheme: ContextUriScheme,
  owner: BranchOwnerRef,
): FileDestination {
  const draft = access === "ask" || writeMode === "draft";
  return draft && isDrafted(scheme)
    ? { kind: "draft", owner: owner.owner, ownerHandle: owner.handle }
    : { kind: "live" };
}

/**
 * Where an agent's access to a file of this source goes, decided per source (the fixed rule):
 * its chat's branch for a drafted source in draft mode or where the source asks for review,
 * otherwise live. People always write live. Creates and view paths ask this per source; a
 * document's decision and a tool call's grant carry their own destination (`destinationFor`),
 * and a caller that has one reads it from there.
 */
export function sourceDestination(
  writeMode: AiWriteMode,
  scheme: ContextUriScheme,
  owner: BranchOwnerRef,
): FileDestination {
  return destinationAt(writeMode, FIXED_AI_ACCESS[scheme] ?? "auto-apply", scheme, owner);
}

/** A grant on a node of the tree; v1 has only the owner's, on the project. */
export interface NodeGrant {
  node: FileNode;
  level: FileAccessLevel;
}

/**
 * Where this access reads or writes: an explicit draft target is that draft;
 * an agent writes a drafted source's document, or creates in its folder, through its
 * branch when the chat is in draft mode or the place asks for review.
 */
export function destinationFor(principal: Principal, facts: FileFacts): FileDestination {
  const target = facts.target;
  if (target.kind === "draft") {
    return { kind: "draft", owner: target.owner, ownerHandle: facts.branchOwner?.handle ?? null };
  }
  // A deleted document comes back live, where it was.
  if (target.kind === "restore") return { kind: "live" };
  return principal.agent
    ? destinationAt(
        principal.agent.writeMode,
        placeAccess(facts),
        facts.contentScheme,
        principal.agent.branchOwner,
      )
    : { kind: "live" };
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

/** A deleted Work's files read until its purge; a write to one is refused. */
function workTerms(work: FileWorkFacts): Term[] {
  if (work.deleted) return [{ cap: "read", limit: "work_deleted" }];
  if (work.archived) {
    return [{ cap: "read", limit: "work_archived", work: { id: work.id, handle: work.handle } }];
  }
  return [];
}

/**
 * The agent term (§8): the source's cap for every agent, and each link's
 * permission against its own thread. A `read` link may edit only the scratch
 * of its thread's current Work, No Work's included. A place set to `deny` reads. The minimum wins.
 */
function agentTerms(chain: AgentChain, facts: FileFacts): Term[] {
  const sourceLimit = SOURCE_AGENT_LIMITS[facts.contentScheme];
  const terms: Term[] = sourceLimit ? [sourceLimit] : [];
  for (const link of chain) {
    const ownScratch =
      facts.contentScheme === "scratch" &&
      (link.scratchOwner.scope === "lineage"
        ? facts.ownerRootThreadId === link.scratchOwner.rootThreadId
        : facts.ownerWork?.id === link.scratchOwner.workId);
    const cap = link.permission === "edit" || ownScratch ? "edit" : "read";
    terms.push({ cap, limit: "agent_read_only" });
  }
  if (placeAccess(facts) === "deny") terms.push({ cap: "read", limit: "ai_access_denied" });
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
