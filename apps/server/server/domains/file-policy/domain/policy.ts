import { type ContextUriScheme, isDraftedScheme } from "@meridian/contracts/context-uri";
import type { AiWriteMode } from "@meridian/contracts/works";
import { matchAncestors } from "./ancestors.js";
import {
  type AgentChain,
  type AiAccess,
  type DraftOwnerRef,
  type FileAccessDenial,
  type FileAccessLevel,
  type FileDecision,
  type FileDestination,
  type FileDraftOwnerFacts,
  type FileFacts,
  type FileNode,
  type FileWorkFacts,
  higherLevel,
  lowerLevel,
  type Principal,
  type SkillFacts,
  type WorkRef,
} from "./types.js";

const SOURCE_AGENT_LIMITS: Readonly<
  Partial<Record<ContextUriScheme, { cap: FileAccessLevel; limit: "uploads_read_only" }>>
> = {
  uploads: { cap: "read", limit: "uploads_read_only" },
};

export function isDrafted(scheme: ContextUriScheme): boolean {
  return isDraftedScheme(scheme);
}

const FIXED_AI_ACCESS: Readonly<Partial<Record<ContextUriScheme, AiAccess>>> = {};

export function placeAccess(facts: FileFacts): AiAccess {
  const access =
    facts.aiAccessSettings?.[0]?.access ?? FIXED_AI_ACCESS[facts.contentScheme] ?? "auto-apply";
  return access === "ask" && !isDrafted(facts.contentScheme) ? "deny" : access;
}

function destinationAt(
  writeMode: AiWriteMode,
  access: AiAccess,
  scheme: ContextUriScheme,
  owner: DraftOwnerRef,
): FileDestination {
  const draft = access === "ask" || writeMode === "draft";
  return draft && isDrafted(scheme)
    ? { kind: "draft", draftId: owner.draftId, ownerHandle: owner.handle }
    : { kind: "live" };
}

export function sourceDestination(
  writeMode: AiWriteMode,
  scheme: ContextUriScheme,
  owner: DraftOwnerRef,
): FileDestination {
  return destinationAt(writeMode, FIXED_AI_ACCESS[scheme] ?? "auto-apply", scheme, owner);
}

export interface NodeGrant {
  node: FileNode;
  level: FileAccessLevel;
}

export function destinationFor(principal: Principal, facts: FileFacts): FileDestination {
  const target = facts.target;
  if (target.kind === "draft") {
    return {
      kind: "draft",
      draftId: target.draftId,
      ownerHandle: facts.draftOwner?.handle ?? null,
    };
  }
  if (target.kind === "restore") return { kind: "live" };
  return principal.agent
    ? destinationAt(
        principal.agent.writeMode,
        placeAccess(facts),
        facts.contentScheme,
        principal.agent.draftOwner,
      )
    : { kind: "live" };
}

export function decide(
  principal: Principal,
  facts: FileFacts,
  grants: readonly NodeGrant[],
): FileDecision {
  return levelAt(principal, facts, grants, destinationFor(principal, facts));
}

type Term = { cap: FileAccessLevel; limit: FileAccessDenial; work?: WorkRef };

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
  const command =
    personLevel(facts, grants) === "edit" &&
    (!principal.agent ||
      agentTerms(principal.agent.chain, facts).every((term) => term.cap === "edit"));
  return {
    command,
    level,
    limitedBy: limiting?.limit ?? null,
    archivedWork: limiting?.limit === "work_archived" ? (limiting.work ?? null) : null,
    destination: at,
  };
}

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
 * reads draft views for a live destination). Its owning Work archived, or
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
    if (facts.draftOwner?.draftId !== at.draftId) {
      throw new Error(`File facts lack the draft ${at.draftId}`);
    }
    terms.push(...draftOwnerTerms(facts.draftOwner));
  }
  return terms;
}

function draftOwnerTerms(owner: FileDraftOwnerFacts): Term[] {
  if (owner.purged) return [{ cap: "none", limit: "not_found" }];
  if (!owner.owner) return [];
  if (owner.owner.kind === "lineage") {
    return owner.frozen ? [{ cap: "read", limit: "chat_frozen" }] : [];
  }
  return workTerms({ id: owner.owner.workId, ...owner });
}

function workTerms(work: FileWorkFacts): Term[] {
  if (work.deleted) return [{ cap: "read", limit: "work_deleted" }];
  if (work.archived) {
    return [{ cap: "read", limit: "work_archived", work: { id: work.id, handle: work.handle } }];
  }
  return [];
}

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

export function skillLevel(facts: SkillFacts, skill: string): FileAccessLevel {
  const visible =
    facts.load.includes(skill) ||
    facts.invoked.includes(skill) ||
    facts.available.some((entry) => entry.slug === skill && entry.modelInvocable);
  return visible ? "read" : "none";
}
