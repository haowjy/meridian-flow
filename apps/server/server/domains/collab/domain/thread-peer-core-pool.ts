/** The one model-edit entry point: routes per document to live or a thread peer, saves each reply once. */
import {
  type AgentEditCore,
  modelResult,
  parseDocumentAddress,
  type ReadCommand,
  type ResponseCommitSuccessResult,
  type ResponseRollbackResult,
  type ReversalStore,
  splitDocumentFile,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { TreeView } from "../../context/tree/tree-view.js";
import {
  type FileAccess,
  type FileDestination,
  type FileGrant,
  runWithEditGrants,
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
import type { BranchLockLease } from "./branch-critical-sections.js";
import type { BranchReversalHistoryReader } from "./branch-reversal-history.js";
import type { Drafts } from "./drafts.js";
import { pinStaged, type ReplyRecord, type ReplySaveFences } from "./reply-save-fences.js";
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

type PulledThreadPeer = {
  branchId: string;
  branchGeneration: number;
  afterJournalId?: number;
  liveJournalSeq?: number;
  attributionBaseline: Uint8Array;
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
  /** A reply's pins, its save's leases and its confirmation under lock. */
  fences: ReplySaveFences;
  /**
   * Confirms grants under lock: at a seam for a write that commits now, once at
   * a reply's save. Authorizes a reversal at the destination its write landed in.
   */
  fileAccess: Pick<FileAccess, "authorize" | "authorizeAt" | "confirmEdit">;
  maxThreadCores?: number;
}): ThreadPeerAgentEditCore {
  const cores = new Map<ThreadId, AgentEditCore>();
  const activeResponseIds = new Map<ThreadId, Set<string>>();
  const responses = new Map<string, ReplyRecord>();
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
      await evicted?.evictThread(oldest);
      cores.delete(oldest);
      activeResponseIds.delete(oldest);
    }
  }

  function responseFor(responseId: string, threadId: string | undefined): ReplyRecord {
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
    const record: ReplyRecord = {
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
      await core.invalidateThreadDocument(documentId, context.threadId);
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
    if (documentId && context.threadId) {
      await core.invalidateThreadDocument(documentId, context.threadId);
    }
    throw result.refusal;
  }

  /**
   * A read never makes a draft (S1). A draft destination whose Work has no active draft
   * reads the live document through the live core, makes no peer, and still reports the
   * version it asked for, whose content is the live base a first write will draft from.
   * With a draft, it pulls the thread's peer in that draft, which may make the peer.
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
    // mid-reply rebind or draft regeneration never splits it across two saves.
    // The chat's mode can't change mid-reply: it changes only between replies (D62).
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
      pinStaged(entry, staged);
      return core.write(command, staged);
    };
    // An immediate drafted write that lost its draft to a close (Discard all, Apply all)
    // between the ensure and its commit refuses like a save does (§2.5), never as a crash.
    const draftClosedUnder = async () =>
      draftView?.kind === "draft" &&
      destination.kind === "draft" &&
      !sameView(await input.drafts.viewForWork(destination.workId), draftView);
    const immediate = async (): Promise<WriteOutcome> => {
      try {
        const done = await commitNow(core, documentId, context, pinned?.grant ?? grant, call);
        return done.isError && done.status === "internal_error" && (await draftClosedUnder())
          ? draftChanged(command)
          : done;
      } catch (cause) {
        if (!(await draftClosedUnder())) throw cause;
        if (documentId && context.threadId) {
          await core.invalidateThreadDocument(documentId, context.threadId);
        }
        return draftChanged(command);
      }
    };
    const outcome = record ? await call() : await immediate();
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
      pinStaged(entry, staged);
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

  async function retireThreadPeers(docId: string, threadIds: readonly string[]): Promise<void> {
    const errors: unknown[] = [];
    for (const threadId of new Set(threadIds)) {
      const id = threadId as ThreadId;
      lastSeen.delete(seenKey(id, docId as DocumentId));
      // Exact (document, thread) invalidation: the thread's other documents keep their state.
      for (const core of [cores.get(id), input.liveUtilityCore]) {
        try {
          await core?.invalidateThreadDocument(docId, threadId);
        } catch (cause) {
          errors.push(cause);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to retire thread peers");
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
      return input.fences.withLeases(record, (branchLease) =>
        input.responseTransactions.run(
          input.commitThreadResponseAtomically,
          async () => {
            // A core whose every document was refused has already closed this
            // reply on its side; only a reply that never wrote falls back to the
            // live core, which closes it.
            const wrote = record.participants.size > 0;
            const refused = await input.fences.confirm(record);
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
      return record ? input.fences.withLeases(record, rollback) : rollback(undefined);
    },
    getAvailability: reversals.getAvailability,
    undo: reversals.undo,
    redo: reversals.redo,
    reverse(inputReverse) {
      return input.liveUtilityCore.reverse(inputReverse);
    },
    retireThreadPeers,
    // One thread on one document: what the reply's own fences retire.
    async invalidateThreadDocument(docId, threadId) {
      await retireThreadPeers(docId, [threadId]);
    },
    async evictThread(threadId) {
      const id = threadId as ThreadId;
      for (const key of [...lastSeen.keys()]) {
        if (key.startsWith(`${id}\0`)) lastSeen.delete(key);
      }
      await cores.get(id)?.evictThread(threadId);
      cores.delete(id);
      activeResponseIds.delete(id);
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

/** The Work's draft this write ensured closed before the write landed (§2.5). */
function draftChanged(command: WriteCommand): WriteOutcome {
  const path = splitDocumentFile(command.file).filePath;
  const message = `This file's draft changed before your write landed (it was applied or discarded), so this change wasn't kept. Read ${path} again before editing.`;
  return {
    status: "invalid_write",
    isError: true,
    revision: null,
    command: command.command,
    result: modelResult({
      command: command.command,
      status: "invalid_write",
      payload: { path, message },
    }),
  };
}

function sameView(a: TreeView, b: LinkView): boolean {
  return a.kind === "draft" && b.kind === "draft" ? a.draftId === b.draftId : a.kind === b.kind;
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
