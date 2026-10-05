/**
 * The file-access service (file-access §1, §3): the only place a `FileGrant`
 * is minted. `authorize` is the preflight; `confirmEdit` is the authoritative
 * re-check a write seam runs inside its transaction.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { decide, levelAt, personLevel } from "./domain/policy.js";
import {
  type AgentChain,
  atLeast,
  type FileAccessDenied,
  type FileDecision,
  type FileDestination,
  type FileFacts,
  type FileGrant,
  type FileNeed,
  type FileTarget,
  grantWorkIds,
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

export interface FileAccess {
  /** Preflight: fast errors and UI state. Advisory for writes. */
  authorize<N extends FileNeed>(
    principal: Principal,
    target: FileTarget,
    need: N,
  ): Promise<FileGrant<N> | FileAccessDenied>;
  /**
   * Edit at an explicit destination instead of the one the principal's mode
   * picks: an undo reverses a write where it landed, which a mode switch since
   * may have moved new writes away from.
   */
  authorizeAt(
    principal: Principal,
    target: FileTarget,
    destination: FileDestination,
  ): Promise<FileGrant<"edit"> | FileAccessDenied>;
  /**
   * Authoritative, inside the ambient transaction (§5, §5.2). The caller has
   * already locked the Works the grants' facts name (`grantWorkIds`), in one
   * id-ordered select with its own. Re-reads facts and each agent chain, and
   * re-runs the policy at each grant's destination. A file whose owner or
   * draft Work moved outside that locked set is refused, since locking it now
   * would break the id order. Refused grants are returned, not thrown, so the
   * rest of the reply can commit.
   */
  confirmEdit(grants: readonly FileGrant<"edit">[]): Promise<FileAccessDenied[]>;
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
      if (!facts) return notFound(principal, target);
      const result = await decision(principal, facts);
      if (!atLeast(result.level, need)) return denied(principal, facts, result);
      return mint(principal, facts, result);
    },

    async authorizeAt(principal, target, destination) {
      const facts = await deps.facts.load({
        target,
        ...(destination.kind === "draft" ? { draftWorkId: destination.workId } : {}),
      });
      if (!facts) return notFound(principal, target);
      const grants = await deps.grants.personGrants(principal.accountId, facts);
      const result = levelAt(principal, facts, grants, destination);
      if (!atLeast(result.level, "edit")) return denied(principal, facts, result);
      return mint(principal, facts, result);
    },

    async confirmEdit(grants) {
      const locked = new Set(grants.flatMap((grant) => grantWorkIds(grant.facts)));
      const fresh: (FileFacts | null)[] = [];
      for (const { facts, destination } of grants) {
        fresh.push(
          await deps.facts.load({
            target: facts.target,
            ...(destination.kind === "draft" ? { draftWorkId: destination.workId } : {}),
          }),
        );
      }
      const chains = new Map<ThreadId, Promise<AgentChain>>();
      const freshChain = (threadId: ThreadId) => {
        let chain = chains.get(threadId);
        if (!chain) {
          chain = deps.readAgentChain(threadId);
          chains.set(threadId, chain);
        }
        return chain;
      };
      const refused: FileAccessDenied[] = [];
      for (const [index, grant] of grants.entries()) {
        const facts = fresh[index];
        if (!facts || !grantWorkIds(facts).every((id) => locked.has(id))) {
          refused.push(notFound(grant.principal, grant.facts.target));
          continue;
        }
        const principal = await refreshPrincipal(grant.principal, freshChain);
        const personGrants = await deps.grants.personGrants(principal.accountId, facts);
        const at = levelAt(principal, facts, personGrants, grant.destination);
        if (!atLeast(at.level, "edit")) refused.push(denied(principal, facts, at));
      }
      return refused;
    },

    async historyAccess(principal, documentId) {
      const facts = await deps.facts.load({ target: { kind: "document", documentId } });
      if (!facts || facts.projectDeleted) return null;
      const grants = await deps.grants.personGrants(principal.accountId, facts);
      if (!atLeast(personLevel(facts, grants), "read")) return null;
      return facts.deleted || facts.ownerWork?.deleted === true ? "deleted" : "available";
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

/** An agent's document or container access may go through its draft-mode Work's draft. */
function factsRequest(principal: Principal, target: FileTarget): FileFactsRequest {
  const draftWork = principal.agent?.draftWork;
  return target.kind !== "draft" && draftWork ? { target, draftWorkId: draftWork.id } : { target };
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
  return { principal, facts, destination: result.destination } as unknown as FileGrant<N>;
}

function denied(principal: Principal, facts: FileFacts, result: FileDecision): FileAccessDenied {
  return {
    denied: true,
    target: facts.target,
    reason: result.limitedBy ?? "not_found",
    level: result.level,
    archivedWork: result.archivedWork,
    facts,
    destination: result.destination,
    agentChain: principal.agent?.chain ?? null,
  };
}

function notFound(principal: Principal, target: FileTarget): FileAccessDenied {
  return {
    denied: true,
    target,
    reason: "not_found",
    level: "none",
    archivedWork: null,
    facts: null,
    destination: null,
    agentChain: principal.agent?.chain ?? null,
  };
}
