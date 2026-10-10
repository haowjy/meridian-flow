/** The one model-edit entry point: routes per document to live or a thread peer, saves each reply once. */
import {
  type AgentEditCodecFactory,
  type AgentEditCore,
  createAgentEditCore,
  type DocumentLifecycle,
  modelResult,
  parseDocumentAddress,
  type ReadCommand,
  type ResponseCommitSuccessResult,
  type ResponseRollbackResult,
  type ReversalStore,
  type SemanticProvenanceWriter,
  splitDocumentFile,
  type UpdateJournal,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { AGENT_EDIT_UNDO_CLIENT_ID, createCollabYDoc } from "@meridian/prosemirror-schema";
import {
  type FileAccess,
  type FileDestination,
  type FileGrant,
  grantWorkIds,
  markReplyConfirmed,
  runWithEditGrants,
  targetDocumentId,
} from "../../file-policy/index.js";
import {
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type RefusedResponseDocument,
  type ResponseSaveResult,
  type RoutedReadContext,
  type RoutedWriteContext,
  type RoutedWriteOutcome,
  sameDestination,
  type ThreadPeerAgentEditCore,
} from "./agent-edit-cores.js";
import {
  type BranchAgentEditDiagnostics,
  type BranchConcurrentJournalWatermarks,
  createBranchAgentEditCoordinator,
  createBranchAgentEditJournal,
  createBranchPendingJournalEntries,
  type EnlistResponseParticipant,
} from "./branch-agent-edit.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { BranchCriticalSections, BranchLockLease } from "./branch-critical-sections.js";
import type { BranchPullService } from "./branch-pulls.js";
import type { BranchJournalReadStore } from "./branch-push-contracts.js";
import type { BranchReversalHistoryReader } from "./branch-reversal-history.js";
import { collabHook } from "./collab-test-hooks.js";
import { createScopedDocumentLinks } from "./document-links-port.js";
import type { Drafts } from "./drafts.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import type { AheadRefRegistrar, DocumentLinkScopes } from "./ports/document-link-scope.js";
import type {
  ResponseCommitParticipant,
  ResponseTransactionSettlement,
} from "./response-transaction.js";
import {
  createThreadPeerReversals,
  isReversalCommand,
  type ReversalCommand,
} from "./thread-peer-reversals.js";

export type ResponseTransactionHooks = {
  enlist(participant: ResponseCommitParticipant): boolean;
  run<T>(
    atomic: (operation: () => Promise<T>) => Promise<T>,
    operation: () => Promise<T>,
    settlement: ResponseTransactionSettlement,
  ): Promise<T>;
};

type AgentEditObservability = Pick<
  Parameters<typeof createAgentEditCore>[0],
  | "reversalNoticePort"
  | "onInvariantViolation"
  | "onResponseLifecycleError"
  | "onResponseClaimDiscarded"
  | "onResponseCommitterTransition"
  | "onIdempotencyHit"
  | "onUnexpectedWriteError"
  | "onReversalNoticeFailed"
  | "onLinkSpliceFallback"
>;

export function createBranchThreadPeerAgentEditCore(input: {
  liveUtilityCore: LiveAgentEditCore;
  journal: UpdateJournal & ReversalStore;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  branches: ApplicationBranchStore;
  branchCoordinator: BranchCoordinator;
  branchPulls: BranchPullService;
  branchJournal: BranchJournalReadStore;
  concurrentJournalWatermarks: BranchConcurrentJournalWatermarks;
  diagnostics: BranchAgentEditDiagnostics;
  afterCommit(callback: () => void | Promise<void>): void;
  enlistResponseParticipant: EnlistResponseParticipant;
  model: YProsemirrorDocumentModel;
  codec: AgentEditCodecFactory;
  links: DocumentLinkScopes;
  aheadRefs: AheadRefRegistrar;
  semanticProvenance: SemanticProvenanceWriter;
  observability: AgentEditObservability;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  lockWorks(workIds: readonly string[]): Promise<void>;
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  drafts: Pick<Drafts, "viewForWork" | "ensureActiveForWrite" | "shareActive">;
  criticalSections: BranchCriticalSections;
}): ThreadPeerAgentEditCore {
  return createThreadPeerCorePool({
    drafts: input.drafts,
    pinFences: createReplyPinFences(input),
    liveUtilityCore: input.liveUtilityCore,
    liveHistory: input.journal,
    afterLiveCommit: (documentId) => input.branchPulls.scheduleLivePull(documentId),
    fileAccess: input.fileAccess,
    lockWorks: input.lockWorks,
    lockLiveDocuments: input.lockLiveDocuments,
    commitThreadResponseAtomically: input.commitThreadResponseAtomically,
    responseTransactionSettlement: input.responseTransactionSettlement,
    responseTransactions: input.responseTransactions,
    createThreadCore: (threadId, viewFor) => {
      const pendingJournalEntries = createBranchPendingJournalEntries(
        input.enlistResponseParticipant,
        input.diagnostics,
      );
      return createAgentEditCore({
        links: createScopedDocumentLinks({
          scopes: input.links,
          registrar: input.aheadRefs,
          viewFor,
        }),
        journal: createBranchAgentEditJournal({
          threadId,
          liveJournal: input.journal,
          pendingJournalEntries,
          branches: input.branches,
          branchRows: {
            listJournalRowsForBranch: (command) =>
              input.branchJournal.listJournalRowsForBranch(command),
          },
        }),
        coordinator: createBranchAgentEditCoordinator({
          threadId,
          branchCoordinator: input.branchCoordinator,
          branches: input.branches,
          pendingJournalEntries,
          journalRows: input.branchJournal,
          liveJournal: input.journal,
          diagnostics: input.diagnostics,
          afterCommit: input.afterCommit,
          enlistResponseParticipant: input.enlistResponseParticipant,
          model: input.model,
          // Attribution compares blocks as stored: a linked document's move is no one's edit.
          codec: input.codec.forScope(UNSCOPED_DOCUMENT_LINKS),
          concurrentJournalWatermarks: input.concurrentJournalWatermarks,
        }),
        lifecycle: input.lifecycle,
        codec: input.codec,
        model: input.model,
        semanticProvenance: input.semanticProvenance,
        defaultThreadId: threadId,
        undoClientId: AGENT_EDIT_UNDO_CLIENT_ID,
        createRuntimeDoc: () => createCollabYDoc({ gc: false }),
        ...input.observability,
      });
    },
    reversalHistory: { branches: input.branches, branchRows: input.branchJournal },
    discardThreadPeerBranches: (documentId, threadId) =>
      input.branches.discardActiveThreadPeerBranches({
        documentId,
        threadId: threadId ? (threadId as ThreadId) : null,
      }),
    pullThreadPeer: (command) => input.branchPulls.pullThreadPeer(command),
  });
}

/**
 * The save's pin fences over the branch store: leases on the pinned peers and their draft
 * branches, and the recheck under the save's Work locks (contract §2.5, steps 2 and 4).
 */
function createReplyPinFences(input: {
  branches: Pick<ApplicationBranchStore, "getBranch">;
  criticalSections: BranchCriticalSections;
  drafts: Pick<Drafts, "shareActive">;
}): ReplyPinFences {
  return {
    async branchIds(pins) {
      const ids = new Set<string>();
      for (const pin of pins) {
        ids.add(pin.branchId);
        const peer = await input.branches.getBranch(pin.branchId);
        if (peer?.upstreamBranchId) ids.add(peer.upstreamBranchId);
      }
      return [...ids];
    },
    withLeases: (branchIds, run) => input.criticalSections.withBranches(branchIds, run),
    async stale(pins) {
      const stale = new Set<DocumentId>();
      const draftActive = new Map<DraftId, boolean>();
      for (const pin of [...pins].sort((a, b) => a.draftId.localeCompare(b.draftId))) {
        if (!draftActive.has(pin.draftId)) {
          draftActive.set(pin.draftId, Boolean(await input.drafts.shareActive(pin.draftId)));
        }
        const peer = await input.branches.getBranch(pin.branchId);
        const upstream = peer?.upstreamBranchId
          ? await input.branches.getBranch(peer.upstreamBranchId)
          : null;
        if (
          !draftActive.get(pin.draftId) ||
          peer?.status !== "active" ||
          peer.draftId !== pin.draftId ||
          upstream?.status !== "active" ||
          upstream.generation !== pin.generation
        ) {
          stale.add(pin.documentId);
        }
      }
      return stale;
    },
  };
}

type PulledThreadPeer = {
  branchId: string;
  branchGeneration: number;
  afterJournalId?: number;
  liveJournalSeq?: number;
  attributionBaseline: Uint8Array;
};

/**
 * A drafted document's staged writes are pinned (contract §2.5): to the draft its first
 * write ensured, the thread peer it staged against, and the draft branch's generation
 * then. Its save resolves exactly these and never provisions another draft.
 */
export type ReplyDraftPin = {
  documentId: DocumentId;
  draftId: DraftId;
  branchId: string;
  generation: number;
};

/** The save's fences on its pins: leases before its transaction, a recheck under its locks. */
export type ReplyPinFences = {
  /** Outside any transaction: the pinned peers and their upstream draft branches. */
  branchIds(pins: readonly ReplyDraftPin[]): Promise<string[]>;
  /** In-process branch leases, sorted, held for `run` (taken before any DB lock, §14). */
  withLeases<T>(
    branchIds: readonly string[],
    run: (lease: BranchLockLease) => Promise<T>,
  ): Promise<T>;
  /**
   * Under the save's Work locks: the documents whose pin no longer holds (peer closed,
   * draft branch reset or closed, draft closed). Locks the drafts `FOR SHARE`.
   */
  stale(pins: readonly ReplyDraftPin[]): Promise<ReadonlySet<DocumentId>>;
};

/**
 * One document's place in a reply: its grant, and with it its destination and
 * the link view that destination resolved to, is pinned at its first write; a
 * drafted one also pins its draft and peer.
 */
type PinnedDocument = {
  core: AgentEditCore;
  grant: FileGrant<"edit">;
  linkView: LinkView;
  pin?: Omit<ReplyDraftPin, "documentId">;
};

type ResponseRecord = {
  threadId?: ThreadId;
  /** Every core holding this reply's buffered writes; each saves in the reply's one step. */
  participants: Set<AgentEditCore>;
  documents: Map<DocumentId, PinnedDocument>;
  /** Drafted reversals staged in the reply; history routed them, so they pin nothing. */
  reversals: Map<DocumentId, PinnedDocument>;
};

/**
 * The single entry point for model reads and writes in both destinations
 * (D19). Each call carries the grant the caller got from the file policy: its
 * destination routes the call, and the write is confirmed under lock where it
 * becomes durable (file-access §5): in the seam's own transaction for a write
 * that commits at once, and once for the whole reply at its save (§5.2).
 */
export function createThreadPeerCorePool(input: {
  liveUtilityCore: LiveAgentEditCore;
  /**
   * `viewFor` is the view a command on this thread's core spells in: the one
   * the pool routed it to (`WriteContext.linkView`), or at a reply's save its
   * document's pinned destination.
   */
  createThreadCore(
    threadId: ThreadId,
    viewFor: (documentId: string, context: WriteContext | undefined) => LinkView,
  ): AgentEditCore;
  /** The thread's Work-draft history: its undo and redo reverse drafted writes there. */
  reversalHistory: BranchReversalHistoryReader;
  /** The live journal's history: its undo and redo reverse live writes live. */
  liveHistory: Pick<ReversalStore, "activeWriteSummary" | "readReversals">;
  discardThreadPeerBranches(documentId: DocumentId, threadId: string): Promise<void>;
  /** The thread's peer in this draft, pulled current; never ensures a draft. */
  pullThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId: DraftId;
  }): Promise<PulledThreadPeer | undefined>;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  /** Runs after an AI write commits to a live document, e.g. to merge it into Work drafts (D40). */
  afterLiveCommit?(documentId: DocumentId): void;
  /**
   * A read maps a draft destination to its link view and never makes a draft (S1); a
   * write ensures its draft at this boundary, once per document per reply (B9).
   */
  drafts: Pick<Drafts, "viewForWork" | "ensureActiveForWrite">;
  pinFences: ReplyPinFences;
  /**
   * Confirms grants under lock: at a seam for a write that commits now, once at
   * a reply's save. Authorizes a reversal at the destination its write landed in.
   */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  /** Locks Work rows `FOR NO KEY UPDATE` in one id-ordered select, in the save's transaction. */
  lockWorks(workIds: readonly string[]): Promise<void>;
  /** A reply's live documents' mutation locks, sorted, after its Work locks (§5.2). */
  lockLiveDocuments(documentIds: readonly DocumentId[]): Promise<void>;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responses = new Map<string, ResponseRecord>();
  // D41: the version of each document the model last read or wrote, per thread.
  // Process-local like the runtime docs it guards; a restart forgets it.
  const lastSeen = new Map<string, FileDestination>();
  const maxThreadCores = input.maxThreadCores ?? 128;

  /**
   * Every call the pool routes carries its view; a reply's save names only
   * the reply, so its documents spell in the destination each was pinned to.
   */
  function threadViewFor(threadId: ThreadId) {
    return (documentId: string, context: WriteContext | undefined): LinkView => {
      if (context?.linkView) return context.linkView;
      const responseId = context?.responseId;
      const record = responseId ? responses.get(responseId) : undefined;
      const pinned =
        record?.documents.get(documentId as DocumentId) ??
        record?.reversals.get(documentId as DocumentId);
      if (pinned) return pinned.linkView;
      throw new Error(
        `Thread ${threadId} spelled ${documentId} without a routed link view; route the call through the pool.`,
      );
    };
  }

  async function coreFor(threadId: string | undefined): Promise<AgentEditCore> {
    if (!threadId) return input.liveUtilityCore;
    const id = threadId as ThreadId;
    const existing = cores.get(id);
    if (existing) {
      cores.delete(id);
      cores.set(id, existing);
      return existing;
    }
    const core = input.createThreadCore(id, threadViewFor(id));
    cores.set(id, core);
    await evictIdleCores();
    return core;
  }

  async function evictIdleCores(): Promise<void> {
    while (cores.size > maxThreadCores) {
      const oldest = [...cores.keys()].find((threadId) => !activeResponseIds.get(threadId)?.size);
      if (!oldest) break;
      const evicted = cores.get(oldest);
      await evicted?.invalidateThread("", oldest);
      cores.delete(oldest);
      activeResponseIds.delete(oldest);
    }
  }

  function responseFor(responseId: string, threadId: string | undefined): ResponseRecord {
    const existing = responses.get(responseId);
    if (existing) {
      if (existing.threadId !== threadId) {
        throw new Error(
          `Response ${responseId} is already owned by thread ${existing.threadId ?? "live"}; cannot reuse it from thread ${threadId ?? "live"}.`,
        );
      }
      return existing;
    }
    const id = threadId as ThreadId | undefined;
    const record: ResponseRecord = {
      ...(id ? { threadId: id } : {}),
      participants: new Set(),
      documents: new Map(),
      reversals: new Map(),
    };
    responses.set(responseId, record);
    if (id) {
      const active = activeResponseIds.get(id) ?? new Set<string>();
      active.add(responseId);
      activeResponseIds.set(id, active);
    }
    return record;
  }

  async function untrackResponse(responseId: string): Promise<void> {
    const record = responses.get(responseId);
    responses.delete(responseId);
    if (record?.threadId) {
      const active = activeResponseIds.get(record.threadId);
      active?.delete(responseId);
      if (active?.size === 0) activeResponseIds.delete(record.threadId);
    }
    await evictIdleCores();
  }

  /**
   * The routed call's link view (§2.3): a draft destination reads in its Work's active
   * draft, a Work with no draft yet reads live (F7). Resolved here, at the async boundary,
   * so `viewFor` and `scopeFor` stay synchronous; a pinned document keeps its first view.
   */
  async function routedTo(
    context: WriteContext,
    destination: FileDestination,
    pinned: LinkView | undefined,
  ): Promise<WriteContext & { linkView: LinkView }> {
    const linkView: LinkView =
      pinned ??
      (destination.kind === "draft"
        ? await input.drafts.viewForWork(destination.workId)
        : { kind: "live" });
    return { ...context, linkView };
  }

  function seenKey(threadId: string, documentId: DocumentId): string {
    return `${threadId}\0${documentId}`;
  }

  /**
   * Pulls this thread's peer in the call's draft before a drafted call, so it sees the
   * current draft, and fences the call on that peer (its id and generation).
   */
  async function threadPeerContext(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
  ): Promise<WriteContext> {
    if (!documentId || !context.threadId || core === input.liveUtilityCore) return context;
    if (context.responseId && core.hasResponseDocument(context.responseId, documentId)) {
      return context;
    }
    if (context.linkView?.kind !== "draft") {
      throw new Error(`A drafted call on ${documentId} reached the thread core without a draft`);
    }
    const pulled = await input.pullThreadPeer({
      documentId,
      threadId: context.threadId as ThreadId,
      draftId: context.linkView.draftId,
    });
    if (!pulled) return context;
    if (!context.responseId) {
      await core.invalidateThread(documentId, context.threadId);
    }
    return {
      ...context,
      interactionContext: {
        mode: "threadPeer" as const,
        branchId: pulled.branchId,
        branchGeneration: pulled.branchGeneration,
        afterJournalId: pulled.afterJournalId ?? 0,
        liveJournalSeq: pulled.liveJournalSeq,
        attributionBaseline: pulled.attributionBaseline,
      },
    };
  }

  /** Records the peer a reply's drafted call just staged against as its document's pin. */
  function pinPulled(entry: PinnedDocument | undefined, context: WriteContext): void {
    const pulled = context.interactionContext;
    if (!entry || pulled?.mode !== "threadPeer" || entry.linkView.kind !== "draft") return;
    entry.pin = {
      draftId: entry.linkView.draftId,
      branchId: pulled.branchId,
      generation: pulled.branchGeneration,
    };
  }

  /**
   * A write that commits at once (no reply, or a live reversal): the seams it
   * reaches confirm its grant in their own transaction. A refusal drops the
   * thread's runtime copy of the document and surfaces as the typed error.
   */
  async function commitNow(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
    grant: FileGrant<"edit">,
    write: () => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    const result = await runWithEditGrants(input.fileAccess, [grant], write);
    if (result.ok) return result.value;
    if (documentId && context.threadId) await core.invalidateThread(documentId, context.threadId);
    throw result.refusal;
  }

  /**
   * A read never makes a draft or a peer (S1): a draft destination whose Work has no
   * active draft reads the live document through the live core and still reports the
   * version it asked for, whose content is the live base a first write will draft from.
   */
  async function read(command: ReadCommand, routed: RoutedReadContext): Promise<WriteOutcome> {
    const { grant, liveVersion, ...context } = routed;
    const requested = grant.destination;
    const documentId = documentIdFromCommand(command);
    const pinned =
      documentId && context.responseId && !liveVersion
        ? responses.get(context.responseId)?.documents.get(documentId)
        : undefined;
    const destination = liveVersion
      ? ({ kind: "live" } as const)
      : (pinned?.grant.destination ?? requested);
    const routedContext = await routedTo(context, destination, pinned?.linkView);
    const core =
      pinned?.core ??
      (routedContext.linkView.kind === "draft"
        ? await coreFor(context.threadId)
        : input.liveUtilityCore);
    const outcome = await core.read(
      command,
      await threadPeerContext(core, documentId, routedContext),
    );
    if (outcome.isError) return outcome;
    if (documentId && context.threadId) {
      lastSeen.set(seenKey(context.threadId, documentId), destination);
    }
    const read = outcome.result.read;
    // Results name the version actually read, which a reply's pin can choose.
    return read
      ? { ...outcome, result: { ...outcome.result, read: { ...read, version: destination.kind } } }
      : outcome;
  }

  /**
   * The write boundary (contract §2.5): a draft destination's first write on a document in
   * a reply ensures the Work's draft in its own transaction, outside any other, and pins
   * it; an immediate write ensures it per call.
   */
  async function write(
    command: WriteCommand,
    routed: RoutedWriteContext,
  ): Promise<RoutedWriteOutcome> {
    const { grant, ...context } = routed;
    if (isReversalCommand(command)) {
      return reversals.reverse(command, context, grant, documentIdFromCommand(command));
    }
    const documentId = documentIdFromCommand(command);
    const record = context.responseId
      ? responseFor(context.responseId, context.threadId)
      : undefined;
    const pinned = documentId ? record?.documents.get(documentId) : undefined;
    // A document keeps its first destination for the rest of the reply, so a
    // mid-reply mode switch never splits it across two saves.
    const destination = pinned?.grant.destination ?? grant.destination;
    if (documentId && context.threadId) {
      const seen = lastSeen.get(seenKey(context.threadId, documentId));
      if (seen && !sameDestination(seen, destination)) {
        return readRequired(command, seen, destination);
      }
    }
    const core =
      pinned?.core ??
      (destination.kind === "live" ? input.liveUtilityCore : await coreFor(context.threadId));
    const draftView: LinkView | undefined =
      pinned || destination.kind !== "draft"
        ? undefined
        : {
            kind: "draft",
            draftId: (
              await input.drafts.ensureActiveForWrite({
                workId: destination.workId,
                projectId: grant.facts.projectId,
                threadId: (context.threadId as ThreadId | undefined) ?? null,
                userId: grant.principal.accountId,
              })
            ).id,
          };
    const routedContext = await routedTo(context, destination, pinned?.linkView ?? draftView);
    let entry = pinned;
    if (record) {
      record.participants.add(core);
      if (documentId && !pinned) {
        entry = { core, grant, linkView: routedContext.linkView };
        record.documents.set(documentId, entry);
      }
    }
    const call = async () => {
      const staged = await threadPeerContext(core, documentId, routedContext);
      pinPulled(entry, staged);
      return core.write(command, staged);
    };
    const outcome = record
      ? await call()
      : await commitNow(core, documentId, context, pinned?.grant ?? grant, call);
    if (!outcome.isError && documentId) {
      if (context.threadId) lastSeen.set(seenKey(context.threadId, documentId), destination);
      if (!context.responseId && destination.kind === "live") input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  async function reverseIn(
    core: AgentEditCore,
    command: ReversalCommand,
    documentId: DocumentId | null,
    context: WriteContext,
    grant: FileGrant<"edit">,
  ): Promise<WriteOutcome> {
    // Live reversals commit immediately and never join the reply's save.
    const record =
      core !== input.liveUtilityCore && context.responseId
        ? responseFor(context.responseId, context.threadId)
        : undefined;
    if (record) {
      record.participants.add(core);
      if (documentId && !record.reversals.has(documentId)) {
        record.reversals.set(documentId, {
          core,
          grant,
          linkView: context.linkView ?? { kind: "live" },
        });
      }
    }
    const entry = documentId ? record?.reversals.get(documentId) : undefined;
    const call = async () => {
      const staged = await threadPeerContext(core, documentId, context);
      pinPulled(entry, staged);
      return core.write(command, staged);
    };
    const outcome = record ? await call() : await commitNow(core, documentId, context, grant, call);
    if (!outcome.isError && documentId && core === input.liveUtilityCore) {
      input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  const reversals = createThreadPeerReversals({
    liveUtilityCore: input.liveUtilityCore,
    coreFor,
    reversalHistory: input.reversalHistory,
    liveHistory: input.liveHistory,
    fileAccess: input.fileAccess,
    reverseIn,
  });

  /** Every drafted document's pin in the reply, writes and reversals alike. */
  function draftPins(record: ResponseRecord): ReplyDraftPin[] {
    const pins = new Map<DocumentId, ReplyDraftPin>();
    for (const [documentId, entry] of [...record.documents, ...record.reversals]) {
      if (entry.pin && !pins.has(documentId)) pins.set(documentId, { documentId, ...entry.pin });
    }
    return [...pins.values()];
  }

  /**
   * Lock once per reply (file-access §5.2): every grant the reply wrote under,
   * confirmed together (its Works locked in id order), each drafted pin rechecked
   * under those locks, then its live documents' mutation locks in id order,
   * before any participant commits. A refused or stale document leaves the
   * reply; the rest saves (D29, D42). Nothing here ensures a draft or a peer.
   */
  async function confirmReply(record: ResponseRecord): Promise<RefusedResponseDocument[]> {
    const pinned = [...record.documents, ...record.reversals];
    if (pinned.length === 0) return [];
    const grants = pinned.map(([, entry]) => entry.grant);
    await input.lockWorks(grants.flatMap((grant) => grantWorkIds(grant.facts)));
    await collabHook("save.afterWorkLock");
    const refused = await input.fileAccess.confirmEdit(grants);
    const refusals = new Map<DocumentId, RefusedResponseDocument>();
    for (const denial of refused) {
      const documentId = targetDocumentId(denial.target);
      refusals.set(documentId, { documentId, denial });
    }
    for (const documentId of await input.pinFences.stale(draftPins(record))) {
      if (!refusals.has(documentId)) refusals.set(documentId, { documentId, stale: true });
    }
    for (const documentId of refusals.keys()) {
      for (const documents of [record.documents, record.reversals]) {
        const entry = documents.get(documentId);
        if (!entry) continue;
        documents.delete(documentId);
        if (record.threadId) await entry.core.invalidateThread(documentId, record.threadId);
      }
    }
    for (const core of [...record.participants]) {
      const holds = (entry: PinnedDocument) => entry.core === core;
      const writesElsewhere =
        [...record.documents.values()].some(holds) || [...record.reversals.values()].some(holds);
      if (!writesElsewhere && pinned.some(([, entry]) => holds(entry))) {
        record.participants.delete(core);
      }
    }
    // The seams these documents' participants reach take this as their grant.
    markReplyConfirmed([...record.documents.keys(), ...record.reversals.keys()]);
    await input.lockLiveDocuments(
      [...record.documents]
        .filter(([, entry]) => entry.core === input.liveUtilityCore)
        .map(([documentId]) => documentId)
        .sort(),
    );
    return [...refusals.values()];
  }

  function finalizeOptions() {
    return {
      deferFinalization: (participant: ResponseCommitParticipant) => {
        if (!input.responseTransactions.enlist(participant)) {
          throw new Error("Response finalization requires an active response transaction");
        }
      },
    };
  }

  /** A thread core saves its pinned documents under the leases the save already holds. */
  function participantOptions(core: AgentEditCore, branchLease: BranchLockLease | undefined) {
    return core === input.liveUtilityCore || !branchLease
      ? finalizeOptions()
      : { ...finalizeOptions(), branchLease };
  }

  /**
   * A save or rollback of drafted writes takes its branches' leases first, before its
   * transaction opens (V2-H2, contract §14), and holds them through commit or abort, so it
   * and a whole-draft close serialize on the leases and never on a Work row.
   */
  async function withPinLeases<T>(
    record: ResponseRecord,
    run: (lease: BranchLockLease | undefined) => Promise<T>,
  ): Promise<T> {
    const pins = draftPins(record);
    const branchIds = pins.length === 0 ? [] : await input.pinFences.branchIds(pins);
    return branchIds.length === 0
      ? run(undefined)
      : input.pinFences.withLeases(branchIds, (lease) => run(lease));
  }

  return asThreadPeerAgentEditCore({
    read,
    write,
    recover(docId) {
      return Promise.all([
        input.liveUtilityCore.recover(docId),
        ...[...cores.values()].map((core) => core.recover(docId)),
      ]).then(() => {});
    },
    async commitResponse(responseId, options) {
      const record = responses.get(responseId);
      if (!record) {
        // A reply that wrote nothing has nothing to save; it only closes.
        const closed = await input.liveUtilityCore.commitResponse(responseId);
        const saved = mergeSaveResults(responseId, [closed], new Set(), []);
        await options?.beforeTransactionCommit?.(saved);
        return saved;
      }
      return withPinLeases(record, (branchLease) =>
        input.responseTransactions.run(
          input.commitThreadResponseAtomically,
          async () => {
            // A core whose every document was refused has already closed this
            // reply on its side; only a reply that never wrote falls back to the
            // live core, which closes it.
            const wrote = record.participants.size > 0;
            const refused = await confirmReply(record);
            const participants = wrote ? [...record.participants] : [input.liveUtilityCore];
            const results: ResponseCommitSuccessResult[] = [];
            for (const core of participants) {
              results.push(
                await core.commitResponse(responseId, participantOptions(core, branchLease)),
              );
            }
            const drafted = new Set(
              [...record.documents]
                .filter(([, pinned]) => pinned.grant.destination.kind === "draft")
                .map(([documentId]) => documentId),
            );
            const saved = mergeSaveResults(responseId, results, drafted, refused);
            await options?.beforeTransactionCommit?.(saved);
            input.responseTransactions.enlist({
              commit: async () => {
                await untrackResponse(responseId);
                for (const document of saved.documents) {
                  const documentId = document.documentId as DocumentId;
                  if (!drafted.has(documentId)) input.afterLiveCommit?.(documentId);
                }
              },
              abort() {},
            });
            return saved;
          },
          input.responseTransactionSettlement,
        ),
      );
    },
    responseDestination(responseId, docId) {
      return responses.get(responseId)?.documents.get(docId as DocumentId)?.grant.destination;
    },
    hasResponseDocument(responseId, docId) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return pinned?.core.hasResponseDocument(responseId, docId) ?? false;
    },
    withResponseDocument(responseId, docId, base, readDocument) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return (
        pinned?.core.withResponseDocument(responseId, docId, base, readDocument) ??
        Promise.resolve(null)
      );
    },
    async rollbackResponse(responseId) {
      const record = responses.get(responseId);
      const rollback = (branchLease: BranchLockLease | undefined) =>
        input.responseTransactions.run(
          input.commitThreadResponseAtomically,
          async () => {
            const participants =
              record && record.participants.size > 0
                ? [...record.participants]
                : [input.liveUtilityCore];
            // Every participant rolls back even when one throws, so no core keeps
            // the reply's writes buffered.
            const results: ResponseRollbackResult[] = [];
            const failures: unknown[] = [];
            for (const core of participants) {
              try {
                results.push(
                  await core.rollbackResponse(responseId, participantOptions(core, branchLease)),
                );
              } catch (error) {
                failures.push(error);
              }
            }
            if (failures.length > 0) throw failures[0];
            input.responseTransactions.enlist({
              commit: () => untrackResponse(responseId),
              abort() {},
            });
            return mergeRollbackResults(responseId, results);
          },
          input.responseTransactionSettlement,
        );
      return record ? withPinLeases(record, rollback) : rollback(undefined);
    },
    getAvailability: reversals.getAvailability,
    undo: reversals.undo,
    redo: reversals.redo,
    reverse(inputReverse) {
      return input.liveUtilityCore.reverse(inputReverse);
    },
    async retireThreadPeers(docId, threadIds) {
      const errors: unknown[] = [];
      for (const threadId of new Set(threadIds)) {
        const id = threadId as ThreadId;
        lastSeen.delete(seenKey(id, docId as DocumentId));
        // Exact (document, thread) invalidation: the thread's other documents keep their state.
        for (const core of [cores.get(id), input.liveUtilityCore]) {
          try {
            await core?.invalidateThread(docId, threadId);
          } catch (cause) {
            errors.push(cause);
          }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Failed to retire thread peers");
    },
    async invalidateThread(docId, threadId) {
      const errors: unknown[] = [];
      if (docId) {
        try {
          await input.discardThreadPeerBranches(docId as DocumentId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (threadId) {
        const id = threadId as ThreadId;
        for (const key of [...lastSeen.keys()]) {
          if (key.startsWith(`${id}\0`) && (!docId || key === seenKey(id, docId as DocumentId))) {
            lastSeen.delete(key);
          }
        }
        const residentCore = cores.get(id);
        try {
          if (residentCore) await residentCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
        cores.delete(id);
        activeResponseIds.delete(id);
      } else {
        for (const [id, core] of [...cores]) {
          try {
            await core.invalidateThread(docId, id);
          } catch (cause) {
            errors.push(cause);
          }
          cores.delete(id);
          activeResponseIds.delete(id);
        }
        try {
          await input.liveUtilityCore.invalidateThread(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "Failed to invalidate all agent-edit runtimes");
      }
    },
  });
}

function mergeSaveResults(
  responseId: string,
  results: readonly ResponseCommitSuccessResult[],
  drafted: ReadonlySet<DocumentId>,
  refused: RefusedResponseDocument[],
): ResponseSaveResult {
  const documents = results.flatMap((result) => result.documents);
  const discardedClaims = results.flatMap((result) => result.discardedClaims ?? []);
  return {
    status: "committed",
    responseId,
    documentCount: documents.length,
    updateCount: results.reduce((total, result) => total + result.updateCount, 0),
    documents,
    stagedCreates: {
      committed: results.flatMap((result) => result.stagedCreates.committed),
      discarded: results.flatMap((result) => result.stagedCreates.discarded),
    },
    ...(results.some((result) => result.awarenessDegraded) ? { awarenessDegraded: true } : {}),
    ...(discardedClaims.length > 0 ? { discardedClaims } : {}),
    draftedDocumentIds: documents
      .map((document) => document.documentId as DocumentId)
      .filter((documentId) => drafted.has(documentId)),
    refused,
  };
}

function mergeRollbackResults(
  responseId: string,
  results: readonly ResponseRollbackResult[],
): ResponseRollbackResult {
  return {
    status: results.some((result) => result.status === "rolledBackDegraded")
      ? "rolledBackDegraded"
      : "rolledBack",
    responseId,
    stagedCreates: {
      committed: results.flatMap((result) => result.stagedCreates.committed),
      discarded: results.flatMap((result) => result.stagedCreates.discarded),
    },
    ...(results.some((result) => result.restorationFailed) ? { restorationFailed: true } : {}),
  };
}

/** D41: the write targets a different version than the model last read. */
function readRequired(
  command: WriteCommand,
  seen: FileDestination,
  destination: FileDestination,
): WriteOutcome {
  const path = splitDocumentFile(command.file).filePath;
  const message = `You last read ${path} ${versionPhrase(seen, "in")}, but your writes now go ${versionPhrase(destination, "to")}. Read it again before editing.`;
  return {
    status: "read_required",
    isError: true,
    revision: null,
    command: command.command,
    result: modelResult({
      command: command.command,
      status: "read_required",
      payload: { path, message },
    }),
  };
}

function versionPhrase(destination: FileDestination, preposition: "in" | "to"): string {
  return destination.kind === "live"
    ? "live"
    : `${preposition} @${destination.workSlug ?? "/"}'s draft`;
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}
