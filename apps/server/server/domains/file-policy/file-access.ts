/**
 * The file-access service (file-access §1, §3): the only place a `FileGrant`
 * is minted. `authorize` is the preflight; `confirmEdit` is the authoritative
 * re-check a write seam runs inside its transaction.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { decide, levelAt } from "./domain/policy.js";
import {
  type AgentChain,
  atLeast,
  type FileAccessDenied,
  type FileDecision,
  type FileFacts,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  type Principal,
} from "./domain/types.js";
import type { FileFactsPort, FileFactsRequest } from "./ports/file-facts.js";
import type { FileGrantsPort } from "./ports/file-grants.js";

export interface FileAccessDeps {
  facts: FileFactsPort;
  grants: FileGrantsPort;
  /** Each link's binding and Work, read fresh (runtime's `readAgentChain`). */
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
}

export interface FileEditConfirmation {
  confirmed: FileGrant<"edit">[];
  refused: FileAccessDenied[];
}

export interface FileAccess {
  /** Preflight: fast errors and UI state. Advisory for writes. */
  authorize<N extends FileNeed>(
    principal: Principal,
    target: FileTarget,
    need: N,
  ): Promise<FileGrant<N> | FileAccessDenied>;
  /**
   * Authoritative, inside the ambient save transaction, once per reply
   * (§5, §5.2): locks the grants' Works in id order, re-reads facts and each
   * agent chain, and re-runs the policy at each grant's destination. Refused
   * grants are reported, not thrown, so the rest of the reply can commit.
   */
  confirmEdit(grants: readonly FileGrant<"edit">[]): Promise<FileEditConfirmation>;
  /** The decision for facts a list adapter already loaded; the same pure policy. */
  levelOf(principal: Principal, facts: FileFacts): Promise<FileDecision>;
  /**
   * The list path (§6): each listed document's decision from one facts query,
   * with an agent's draft rows decided at the draft. A document the principal
   * can't read is absent, so callers drop it.
   */
  listAccess(
    principal: Principal,
    documentIds: readonly DocumentId[],
  ): Promise<Map<DocumentId, FileDecision>>;
  /**
   * History reads (change-trail detail) keep a deleted document's captured
   * evidence: the person term alone decides whether they may see it, and the
   * answer says whether the document is still there. Null when they may not.
   */
  historyAccess(
    principal: Principal,
    documentId: DocumentId,
  ): Promise<"available" | "deleted" | null>;
}

export function createFileAccess(deps: FileAccessDeps): FileAccess {
  async function decision(principal: Principal, facts: FileFacts): Promise<FileDecision> {
    return decide(principal, facts, await deps.grants.personGrants(principal.accountId, facts));
  }

  return {
    async authorize(principal, target, need) {
      const facts = await deps.facts.load(factsRequest(principal, target));
      if (!facts) return notFound(principal, target, need);
      const result = await decision(principal, facts);
      if (!atLeast(result.level, need)) return denied(principal, target, need, result);
      return mint(principal, facts, result);
    },

    async confirmEdit(grants) {
      const requests = grants.map(
        (grant): FileFactsRequest => ({
          target: grant.target,
          ...(grant.destination.kind === "draft" ? { draftWorkId: grant.destination.workId } : {}),
        }),
      );
      const locked = await deps.facts.loadLocked(requests);
      const chains = new Map<ThreadId, Promise<AgentChain>>();
      const freshChain = (threadId: ThreadId) => {
        let chain = chains.get(threadId);
        if (!chain) {
          chain = deps.readAgentChain(threadId);
          chains.set(threadId, chain);
        }
        return chain;
      };
      const result: FileEditConfirmation = { confirmed: [], refused: [] };
      for (const [index, grant] of grants.entries()) {
        const facts = locked[index];
        if (!facts) {
          result.refused.push(notFound(grant.principal, grant.target, "edit"));
          continue;
        }
        const principal = await refreshPrincipal(grant.principal, freshChain);
        const personGrants = await deps.grants.personGrants(principal.accountId, facts);
        const at = levelAt(principal, facts, personGrants, grant.destination);
        if (atLeast(at.level, "edit")) result.confirmed.push(mint(principal, facts, at));
        else result.refused.push(denied(principal, grant.target, "edit", at));
      }
      return result;
    },

    levelOf: decision,

    async historyAccess(principal, documentId) {
      const facts = await deps.facts.load({ target: { kind: "document", documentId } });
      if (!facts || facts.projectDeleted) return null;
      const deleted = facts.deleted || facts.ownerWork?.deleted === true;
      const standing: FileFacts = {
        ...facts,
        deleted: false,
        ownerWork: facts.ownerWork && { ...facts.ownerWork, deleted: false, archived: false },
      };
      const result = await decision({ accountId: principal.accountId }, standing);
      if (!atLeast(result.level, "read")) return null;
      return deleted ? "deleted" : "available";
    },

    async listAccess(principal, documentIds) {
      const facts = await deps.facts.loadList(documentIds, principal.agent?.draftWork?.id);
      const out = new Map<DocumentId, FileDecision>();
      for (const [documentId, fact] of facts) {
        const result = await decision(principal, fact);
        if (atLeast(result.level, "read")) out.set(documentId, result);
      }
      return out;
    },
  };
}

/** An agent's document access may go through its draft-mode Work's draft. */
function factsRequest(principal: Principal, target: FileTarget): FileFactsRequest {
  const draftWork = principal.agent?.draftWork;
  return target.kind === "document" && draftWork
    ? { target, draftWorkId: draftWork.id }
    : { target };
}

async function refreshPrincipal(
  principal: Principal,
  readChain: (threadId: ThreadId) => Promise<AgentChain>,
): Promise<Principal> {
  const caller = principal.agent?.chain[0];
  if (!principal.agent || !caller) return principal;
  return { ...principal, agent: { ...principal.agent, chain: await readChain(caller.threadId) } };
}

function mint<N extends FileNeed>(
  principal: Principal,
  facts: FileFacts,
  result: FileDecision,
): FileGrant<N> {
  return {
    principal,
    target: facts.target,
    facts,
    level: result.level,
    destination: result.destination,
  } as unknown as FileGrant<N>;
}

function denied(
  principal: Principal,
  target: FileTarget,
  need: FileNeed,
  result: FileDecision,
): FileAccessDenied {
  const limitedBy = result.limitedBy ?? "not_found";
  return {
    denied: true,
    target,
    need,
    reason: limitedBy === "deleted" ? "not_found" : limitedBy,
    limitedBy,
    level: result.level,
    archivedWork: result.archivedWork,
    destination: result.destination,
    agentChain: principal.agent?.chain ?? null,
  };
}

function notFound(principal: Principal, target: FileTarget, need: FileNeed): FileAccessDenied {
  return {
    denied: true,
    target,
    need,
    reason: "not_found",
    limitedBy: "not_found",
    level: "none",
    archivedWork: null,
    destination: null,
    agentChain: principal.agent?.chain ?? null,
  };
}
