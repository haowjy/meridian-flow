/**
 * The file-access service (file-access §1, §3): the only place a `FileGrant`
 * is minted. `authorize` is the preflight; `confirmEdit` is the authoritative
 * re-check a write seam runs inside its transaction.
 */
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { TreeView } from "../context/tree/tree-view.js";
import { decide, destinationFor, levelAt, personLevel } from "./domain/policy.js";
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
  grantOwnerLocks,
  type Principal,
} from "./domain/types.js";
import type { FileFactsPort } from "./ports/file-facts.js";
import type { FileGrantsPort } from "./ports/file-grants.js";

interface FileAccessDeps {
  facts: FileFactsPort;
  grants: FileGrantsPort;
  /** Each link's binding and Work, read fresh (runtime's `readAgentChain`). */
  readAgentChain(threadId: ThreadId): Promise<AgentChain>;
}

export interface FileAccess {
  /** Captured destination lifecycle without caller-specific grants. */
  destinationAvailability(
    target: FileTarget,
    destination: FileDestination,
  ): Promise<{ frozen: boolean }>;
  /** Preflight: fast errors and UI state. Advisory for writes. */
  authorize<N extends FileNeed>(
    principal: Principal,
    target: FileTarget,
    need: N,
  ): Promise<FileGrant<N> | FileAccessDenied>;
  /**
   * Access at an explicit destination instead of the one the principal's mode
   * picks: an undo reverses a write where it landed, which a mode switch since
   * may have moved new writes away from. Review previews use a read grant
   * at the item's destination so archived branches remain readable, not editable.
   */
  authorizeAt<N extends FileNeed = "edit">(
    principal: Principal,
    target: FileTarget,
    destination: FileDestination,
    need?: N,
  ): Promise<FileGrant<N> | FileAccessDenied>;
  /**
   * Authoritative, inside the ambient transaction (§5, §5.2). The caller has
   * already locked the Works and lineages the grants' facts name (`grantOwnerLocks`), in one
   * id-ordered select with its own. Re-reads facts and each agent chain, and
   * re-runs the policy at each grant's destination. A file whose owner or
   * branch Work moved outside that locked set is refused, since locking it now
   * would break the id order. Refused grants are returned, not thrown, so the
   * rest of the reply can commit.
   */
  confirmEdit(grants: readonly FileGrant<"edit" | "discard">[]): Promise<FileAccessDenied[]>;
  /**
   * The list path (§6): each listed document's decision from one facts query,
   * with an agent's drafted documents decided in its branch. A document the principal
   * can't read is absent, so callers drop it. `destination` decides every document
   * there instead of where the principal's access sends it (`ls version:"live"`).
   */
  listAccess(
    principal: Principal,
    documentIds: readonly DocumentId[],
    options?: {
      branchViews?: ReadonlyMap<DocumentId, TreeView>;
      destination?: FileDestination;
    },
  ): Promise<Map<DocumentId, FileDecision>>;
  /**
   * History reads keep a deleted document's captured
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
    async destinationAvailability(target, destination) {
      const facts = await deps.facts.load({
        target,
        ...(destination.kind === "draft" ? { branchOwner: destination.owner } : {}),
      });
      if (!facts) return { frozen: false };
      const work = destination.kind === "draft" ? facts.branchOwner : facts.ownerWork;
      const frozenLineage = destination.kind === "draft" && facts.branchOwner?.frozen === true;
      return { frozen: work?.archived === true || work?.deleted === true || frozenLineage };
    },
    async authorize(principal, target, need) {
      const facts = await loadFor(principal, target);
      if (!facts) return notFound(principal, target);
      const result = await decision(principal, facts);
      if (!allows(result, need)) return denied(principal, facts, result);
      return mint(principal, facts, result, need);
    },

    async authorizeAt(principal, target, destination, need) {
      const facts = await deps.facts.load({
        target,
        ...(destination.kind === "draft" ? { branchOwner: destination.owner } : {}),
      });
      if (!facts) return notFound(principal, target);
      const grants = await deps.grants.personGrants(principal.accountId, facts);
      const result = levelAt(principal, facts, grants, destination);
      const asked: FileNeed = need ?? "edit";
      if (!allows(result, asked)) return denied(principal, facts, result);
      return mint(principal, facts, result, asked);
    },

    async confirmEdit(grants) {
      const lockedWorks = new Set(grants.flatMap((grant) => grantOwnerLocks(grant.facts).workIds));
      const lockedLineages = new Set(
        grants.flatMap((grant) => grantOwnerLocks(grant.facts).lineageRootIds),
      );
      const fresh: (FileFacts | null)[] = [];
      for (const { facts, destination } of grants) {
        fresh.push(
          await deps.facts.load({
            target: facts.target,
            ...(destination.kind === "draft" ? { branchOwner: destination.owner } : {}),
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
        const needed = facts ? grantOwnerLocks(facts) : null;
        if (
          !facts ||
          !needed?.workIds.every((id) => lockedWorks.has(id)) ||
          !needed.lineageRootIds.every((id) => lockedLineages.has(id))
        ) {
          refused.push(notFound(grant.principal, grant.facts.target));
          continue;
        }
        const principal = await refreshPrincipal(grant.principal, freshChain);
        const personGrants = await deps.grants.personGrants(principal.accountId, facts);
        const at = levelAt(principal, facts, personGrants, grant.destination);
        if (!allows(at, grant.need)) refused.push(denied(principal, facts, at));
      }
      return refused;
    },

    async historyAccess(principal, documentId) {
      const facts = await deps.facts.load({ target: { kind: "document", documentId } });
      if (!facts || facts.projectDeleted) return null;
      const grants = await deps.grants.personGrants(principal.accountId, facts);
      if (!atLeast(personLevel(facts, grants), "read")) return null;
      return facts.deleted ? "deleted" : "available";
    },

    async listAccess(principal, documentIds, options) {
      const facts = options?.destination
        ? await deps.facts.loadList(documentIds, undefined, options.branchViews)
        : await loadListFor(principal, documentIds, options?.branchViews);
      const out = new Map<DocumentId, FileDecision>();
      for (const [documentId, fact] of facts) {
        const result = options?.destination
          ? levelAt(
              principal,
              fact,
              await deps.grants.personGrants(principal.accountId, fact),
              options.destination,
            )
          : await decision(principal, fact);
        if (atLeast(result.level, "read")) out.set(documentId, result);
      }
      return out;
    },
  };

  /**
   * An agent's facts, decided where its write would land. A chat in draft mode loads its
   * branch's view. Any other chat loads the live tree, and only a place that sends the write to
   * a draft loads the branch (and a document only the branch holds, such as the one an earlier
   * write of this chat created there): the branch's lifecycle and locks apply to a draft, never
   * to a live write.
   */
  async function loadFor(principal: Principal, target: FileTarget): Promise<FileFacts | null> {
    const agent = principal.agent;
    if (!agent || target.kind === "draft" || target.kind === "restore")
      return deps.facts.load({ target });
    const branched = { target, branchOwner: agent.branchOwner.owner };
    if (agent.writeMode === "draft") return deps.facts.load(branched);
    const live = await deps.facts.load({ target });
    if (live && destinationFor(principal, live).kind === "live") return live;
    const drafted = await deps.facts.load(branched);
    return drafted && destinationFor(principal, drafted).kind === "draft" ? drafted : live;
  }

  /** `loadFor` for a list: one live query, then one branch query for the documents that draft. */
  async function loadListFor(
    principal: Principal,
    documentIds: readonly DocumentId[],
    branchViews: ReadonlyMap<DocumentId, TreeView> | undefined,
  ): Promise<Map<DocumentId, FileFacts>> {
    const agent = principal.agent;
    if (!agent) return deps.facts.loadList(documentIds, undefined, branchViews);
    const owner = agent.branchOwner.owner;
    if (agent.writeMode === "draft") return deps.facts.loadList(documentIds, owner, branchViews);
    const live = await deps.facts.loadList(documentIds, undefined, branchViews);
    const toDraft = documentIds.filter((id) => {
      const fact = live.get(id);
      return !fact || destinationFor(principal, fact).kind === "draft";
    });
    if (toDraft.length === 0) return live;
    const drafted = await deps.facts.loadList(toDraft, owner, branchViews);
    for (const [id, fact] of drafted) {
      if (destinationFor(principal, fact).kind === "draft") live.set(id, fact);
    }
    return live;
  }
}

async function refreshPrincipal(
  principal: Principal,
  readChain: (threadId: ThreadId) => Promise<AgentChain>,
): Promise<Principal> {
  const caller = principal.agent?.chain[0];
  if (!principal.agent || !caller) return principal;
  return { ...principal, agent: { ...principal.agent, chain: await readChain(caller.threadId) } };
}

/** `confirmEdit` re-checks a grant against the need it was minted for. */
function allows(result: FileDecision, need: FileNeed): boolean {
  return need === "discard" ? result.discard : atLeast(result.level, need);
}

function mint<N extends FileNeed>(
  principal: Principal,
  facts: FileFacts,
  result: FileDecision,
  need: FileNeed,
): FileGrant<N> {
  return { principal, facts, destination: result.destination, need } as unknown as FileGrant<N>;
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
