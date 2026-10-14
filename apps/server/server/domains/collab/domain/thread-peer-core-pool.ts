/** The one model-edit entry point: routes per document to live or a thread peer, saves each reply once. */
import {
  type AgentEditCore,
  type DiscardedWriteReason,
  modelResult,
  parseDocumentAddress,
  type ReadCommand,
  type ResponseCommitSuccessResult,
  type ResponseRollbackResult,
  rejectedWriteExplanation,
  splitDocumentFile,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { DraftId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import type { FileAccess, FileDestination, FileGrant } from "../../file-policy/index.js";
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
import type {
  ResponseCommitParticipant,
  ResponseTransactionSettlement,
} from "./response-transaction.js";

export type ResponseTransactionHooks = {
  enlist(participant: ResponseCommitParticipant): boolean;
  run<T>(
    atomic: (operation: () => Promise<T>) => Promise<T>,
    operation: () => Promise<T>,
    settlement: ResponseTransactionSettlement,
  ): Promise<T>;
};

import { BranchCasConflictError, BranchStaleUpdateError } from "./branch-coordinator.js";
import { ThreadPeerPullLost } from "./branch-pulls.js";
import type { Drafts } from "./drafts.js";
import type { ApplicationBranchStore } from "./ports/application-branch-store.js";
import { pinStaged, type ReplyRecord, type ReplySaveFences } from "./reply-save-fences.js";

type PulledThreadPeer = {
  peerBranchId: string;
  upstreamBranchId: string;
  afterJournalId?: number;
  liveJournalSeq?: number;
  attributionBaseline: Uint8Array;
};

type ResponseRecord = ReplyRecord;

/**
 * The single entry point for model reads and writes in both destinations
 * (D19). Each call carries the grant the caller got from the file policy: its
 * destination routes the call, and the write is confirmed under lock where it
 * becomes durable (file-access §5): in the seam's own transaction for a write
 * that commits at once, and once for the whole reply at its save (§5.2).
 */
export function createThreadPeerCorePool(input: {
  drafts: Pick<Drafts, "viewForWork" | "ensureActiveForWrite" | "shareActive">;
  branches: Pick<ApplicationBranchStore, "getBranch">;
  fences: ReplySaveFences;
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
  pullThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId?: DraftId;
  }): Promise<PulledThreadPeer | undefined>;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  responseTransactionSettlement: ResponseTransactionSettlement;
  responseTransactions: ResponseTransactionHooks;
  /** Runs after an AI write commits to a live document, e.g. to merge it into Work drafts (D40). */
  afterLiveCommit?(documentId: DocumentId): void;
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
  const responses = new Map<string, ResponseRecord>();
  // D41: the version of each document the model last read or wrote, per thread.
  // Process-local like the runtime docs it guards; a restart forgets it.
  const lastSeen = new Map<string, { destination: FileDestination; peerBranchId?: string }>();
  const maxThreadCores = input.maxThreadCores ?? 128;

  /**
   * Every call the pool routes carries its view; a reply's save names only
   * the reply, so its documents spell in the destination each was pinned to.
   */
  function threadViewFor(threadId: ThreadId) {
    return (documentId: string, context: WriteContext | undefined): LinkView => {
      if (context?.linkView) return context.linkView;
      const responseId = context?.responseIdentity?.editScopeId;
      const record = responseId ? responses.get(responseId) : undefined;
      const pinned = record?.documents.get(documentId as DocumentId);
      if (pinned) return pinned.linkView;
      throw new Error(
        `Thread ${threadId} spelled ${documentId} without a routed link view; route the call through the pool.`,
      );
    };
  }

  function lookupCore(threadId: string | undefined): AgentEditCore {
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
    return core;
  }

  async function evictIdleCores(): Promise<void> {
    while (cores.size > maxThreadCores) {
      const oldest = [...cores.keys()].find(
        (threadId) => ![...responses.values()].some((record) => record.threadId === threadId),
      );
      if (!oldest) break;
      const evicted = cores.get(oldest);
      await evicted?.evictThread(oldest);
      cores.delete(oldest);
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
      responseId,
      ...(id ? { threadId: id } : {}),
      participants: new Set(),
      receipting: new Set(),
      documents: new Map(),
    };
    responses.set(responseId, record);
    return record;
  }

  async function untrackResponse(responseId: string): Promise<void> {
    responses.delete(responseId);
    await evictIdleCores();
  }

  // Residency is a cache; open response participants remain owners after eviction.
  function ownersForThread(threadId: ThreadId): Set<AgentEditCore> {
    const owners = new Set<AgentEditCore>();
    const resident = cores.get(threadId);
    if (resident) owners.add(resident);
    for (const record of responses.values())
      if (record.threadId === threadId) for (const core of record.participants) owners.add(core);
    return owners;
  }

  function seenKey(threadId: string, documentId: DocumentId): string {
    return `${threadId}\0${documentId}`;
  }

  function coreForDestination(destination: FileDestination, threadId: string | undefined) {
    return destination.kind === "live" ? input.liveUtilityCore : lookupCore(threadId);
  }

  /** Pulls this thread's peer before a drafted call so it sees the current Work draft. */
  async function threadPeerContext(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
  ): Promise<WriteContext> {
    if (!documentId || !context.threadId || core === input.liveUtilityCore) return context;
    const pulled = await input.pullThreadPeer({
      documentId,
      threadId: context.threadId as ThreadId,
      draftId: context.linkView?.kind === "draft" ? context.linkView.draftId : undefined,
    });
    if (!pulled) return context;
    // Fresh calls rebuild the runtime from the pulled peer. A previous reply's
    // runtime may contain effects retired by review; Yjs merge cannot erase them.
    // The response committer rebuilds buffered helpers and replays only surviving edits.
    if (
      !context.responseIdentity?.editScopeId ||
      !core.hasResponseDocument(context.responseIdentity?.editScopeId, documentId)
    )
      await core.invalidateThreadDocument(documentId, context.threadId);
    return {
      ...context,
      interactionContext: {
        mode: "threadPeer" as const,
        peerBranchId: pulled.peerBranchId,
        upstreamBranchId: pulled.upstreamBranchId,
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
    if (documentId && context.threadId)
      await core.invalidateThreadDocument(documentId, context.threadId);
    throw result.refusal;
  }

  async function read(command: ReadCommand, routed: RoutedReadContext): Promise<WriteOutcome> {
    const { grant, liveVersion, ...context } = routed;
    const requested = grant.destination;
    const documentId = documentIdFromCommand(command);
    const pinned =
      documentId && context.responseIdentity?.editScopeId && !liveVersion
        ? responses.get(context.responseIdentity?.editScopeId)?.documents.get(documentId)
        : undefined;
    const destination = liveVersion
      ? ({ kind: "live" } as const)
      : (pinned?.grant.destination ?? requested);
    await evictIdleCores();
    const routedContext = await routedTo(context, destination, pinned?.linkView);
    // A read never makes a draft (S1): a draft destination whose Work has no active draft
    // reads the live document through the live core and makes no peer.
    const noDraft =
      !pinned && destination.kind === "draft" && routedContext.linkView.kind !== "draft";
    const core = noDraft
      ? input.liveUtilityCore
      : (pinned?.core ?? coreForDestination(destination, context.threadId));
    const callContext =
      command.format === "edits" || noDraft
        ? routedContext
        : await threadPeerContext(core, documentId, routedContext);
    const outcome = await core.read(command, callContext);
    if (outcome.isError) return outcome;
    if (documentId && context.threadId) {
      lastSeen.set(seenKey(context.threadId, documentId), {
        destination,
        peerBranchId:
          callContext.interactionContext?.mode === "threadPeer"
            ? callContext.interactionContext.peerBranchId
            : undefined,
      });
    }
    const read = outcome.result.read;
    // Results name the version actually read, which a reply's pin can choose.
    return read
      ? { ...outcome, result: { ...outcome.result, read: { ...read, version: destination.kind } } }
      : outcome;
  }

  async function write(
    command: WriteCommand,
    routed: RoutedWriteContext,
  ): Promise<RoutedWriteOutcome> {
    const { grant, ...context } = routed;
    const documentId = documentIdFromCommand(command);
    const record = context.responseIdentity?.editScopeId
      ? responseFor(context.responseIdentity?.editScopeId, context.threadId)
      : undefined;
    const pinned = documentId ? record?.documents.get(documentId) : undefined;
    // A document keeps its first destination for the rest of the reply, so a
    // mid-reply rebind or draft regeneration never splits it across two saves.
    // The chat's mode can't change mid-reply: it changes only between replies (D62).
    const destination = pinned?.grant.destination ?? grant.destination;
    if (documentId && context.threadId) {
      const seen = lastSeen.get(seenKey(context.threadId, documentId));
      if (seen && !sameDestination(seen.destination, destination)) {
        return readRequired(command, seen.destination, destination);
      }
    }
    const core = pinned?.core ?? coreForDestination(destination, context.threadId);
    // Lookup and enrollment are synchronous: close must see the first owner
    // before cache maintenance yields, so that owner's lifecycle rejects late staging.
    record?.participants.add(core);
    await evictIdleCores();
    const immediateInverse = command.command === "revert";
    const draftView: LinkView | undefined =
      pinned || destination.kind !== "draft" || immediateInverse
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
    if (record && documentId && !pinned && !immediateInverse) {
      entry = { core, grant, linkView: routedContext.linkView };
      record.documents.set(documentId, entry);
    }
    let callContext: WriteContext = routedContext;
    const call = async () => {
      if (!immediateInverse) callContext = await threadPeerContext(core, documentId, callContext);
      if (!immediateInverse) pinStaged(entry, callContext);
      return core.write(command, callContext);
    };
    // An immediate drafted write that lost its draft to a close (Discard all) between the
    // ensure and its commit refuses like a save does, never as a crash.
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
        if (documentId && context.threadId)
          await core.invalidateThreadDocument(documentId, context.threadId);
        return draftChanged(command);
      }
    };
    // A staged write whose peer pull lost to Discard all or an item Discard: the same named
    // refusal its save receipt would carry, never the store's raw error.
    const staged = async (): Promise<WriteOutcome> => {
      try {
        return await call();
      } catch (cause) {
        const reason = await discardLossReason(cause, entry?.linkView ?? routedContext.linkView);
        // The reply's earlier staged writes stay: the retirement refuses them with their own receipts.
        if (!reason) throw cause;
        // An entry this attempt installed and never pinned routes the reply to the closed
        // draft, and retirement matches pins only: drop it so the retry ensures a fresh draft.
        if (record && documentId && entry && entry !== pinned && !entry.pin) {
          if (record.documents.get(documentId) === entry) record.documents.delete(documentId);
        }
        return discardedWrite(command, reason);
      }
    };
    const outcome = record && !immediateInverse ? await staged() : await immediate();
    if (!outcome.isError && documentId) {
      if (context.threadId)
        lastSeen.set(seenKey(context.threadId, documentId), {
          destination,
          peerBranchId:
            callContext.interactionContext?.mode === "threadPeer"
              ? callContext.interactionContext.peerBranchId
              : undefined,
        });
      if (!context.responseIdentity?.editScopeId && destination.kind === "live")
        input.afterLiveCommit?.(documentId);
    }
    return outcome;
  }

  /**
   * Why a failed peer pull is Discard's doing, in the save fence's precedence: the draft it
   * pulled for is closed, else the upstream it captured is closed or gone, else its peer is.
   * Any other failure, or a pull whose branches are all still live, is not a Discard.
   */
  async function discardLossReason(
    cause: unknown,
    view: LinkView,
  ): Promise<DiscardedWriteReason | undefined> {
    const lost = cause instanceof ThreadPeerPullLost;
    if (
      !lost &&
      !(cause instanceof BranchStaleUpdateError || cause instanceof BranchCasConflictError)
    )
      return undefined;
    if (view.kind === "draft" && !(await input.drafts.shareActive(view.draftId)))
      return "discarded_draft";
    if (!lost) return undefined;
    const gone = async (branchId: string) => {
      const branch = await input.branches.getBranch(branchId);
      return !branch || branch.status === "closed";
    };
    if (await gone(cause.upstreamBranchId)) return "discarded_document";
    return (await gone(cause.peerBranchId)) ? "discarded_edit" : undefined;
  }

  /**
   * Lock once per reply (file-access §5.2): every grant the reply wrote under,
   * confirmed together (its Works locked in id order), then its live
   * documents' mutation locks in id order, before any participant commits. A
   * refused document leaves the reply; the rest saves (D29, D42).
   */
  function finalizeOptions() {
    return {
      deferFinalization: (participant: ResponseCommitParticipant) => {
        if (!input.responseTransactions.enlist(participant)) {
          throw new Error("Response finalization requires an active response transaction");
        }
      },
    };
  }

  async function retireThreadPeers(
    docId: string,
    peers: readonly {
      threadId: string;
      peerBranchId: string;
      reason: import("@meridian/agent-edit/integration").DiscardedWriteReason;
    }[],
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const { threadId, peerBranchId, reason } of peers) {
      if (!docId || !threadId || !peerBranchId)
        throw new Error("Retirement names one document, thread and peer branch");
      const id = threadId as ThreadId;
      const key = seenKey(id, docId as DocumentId);
      if (lastSeen.get(key)?.peerBranchId === peerBranchId) lastSeen.delete(key);
      for (const record of responses.values()) {
        if (record.threadId !== id) continue;
        for (const core of record.participants) record.receipting.add(core);
        const entry = record.documents.get(docId as DocumentId);
        if (entry?.pin?.peerBranchId === peerBranchId) record.documents.delete(docId as DocumentId);
      }
      // Response-pinned owners survive cache eviction and must lose these buffers too.
      for (const core of new Set([...ownersForThread(id), input.liveUtilityCore])) {
        try {
          await core.retirePeer({ documentId: docId, threadId, peerBranchId, reason });
        } catch (cause) {
          errors.push(cause);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to retire thread peers");
  }

  async function routedTo(
    context: WriteContext,
    destination: FileDestination,
    pinnedView?: LinkView,
  ): Promise<WriteContext & { linkView: LinkView }> {
    const linkView =
      pinnedView ??
      (destination.kind === "live"
        ? { kind: "live" as const }
        : await input.drafts.viewForWork(destination.workId));
    return { ...context, linkView };
  }

  return asThreadPeerAgentEditCore({
    read,
    write,
    refuseStaged(responseId, docId, reason, peerBranchId) {
      const record = responses.get(responseId);
      for (const core of record?.participants ?? []) {
        core.refuseStaged(responseId, docId, reason, peerBranchId);
        record?.receipting.add(core);
      }
      const entry = record?.documents.get(docId as DocumentId);
      if (entry && (!peerBranchId || entry.pin?.peerBranchId === peerBranchId))
        record?.documents.delete(docId as DocumentId);
    },
    retirePeer: ({ documentId, threadId, peerBranchId, reason }) =>
      retireThreadPeers(documentId, [{ threadId, peerBranchId, reason }]),
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
        const saved = mergeSaveResults(responseId, [closed], []);
        await options?.beforeTransactionCommit?.(saved);
        return saved;
      }
      return input.fences.withLeases(record, (lease) =>
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
                await core.commitResponse(responseId, { ...finalizeOptions(), branchLease: lease }),
              );
            }
            const drafted = new Set(
              [...record.documents]
                .filter(([, pinned]) => pinned.grant.destination.kind === "draft")
                .map(([documentId]) => documentId),
            );
            const saved = mergeSaveResults(responseId, results, refused);
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
    prepare(responseId, docId) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return pinned?.core.prepare(responseId, docId) ?? Promise.resolve(null);
    },
    async rollbackResponse(responseId) {
      const record = responses.get(responseId);
      const rollback = () =>
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
                results.push(await core.rollbackResponse(responseId, finalizeOptions()));
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
      return record ? input.fences.withLeases(record, rollback) : rollback();
    },
    retireThreadPeers,
    async invalidateThreadDocument(docId, threadId) {
      if (!docId || !threadId)
        throw new Error("invalidateThreadDocument names one document and one thread");
      lastSeen.delete(seenKey(threadId, docId as DocumentId));
      for (const core of new Set([...ownersForThread(threadId as ThreadId), input.liveUtilityCore]))
        await core.invalidateThreadDocument(docId, threadId);
    },
    async evictThread(threadId) {
      if (!threadId) throw new Error("evictThread names one thread");
      const id = threadId as ThreadId;
      for (const key of [...lastSeen.keys()]) {
        if (key.startsWith(`${id}\0`)) lastSeen.delete(key);
      }
      await cores.get(id)?.evictThread(threadId);
      cores.delete(id);
    },
  });
}

function mergeSaveResults(
  responseId: string,
  results: readonly ResponseCommitSuccessResult[],
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
    refused,
  };
}

function mergeRollbackResults(
  responseId: string,
  results: readonly ResponseRollbackResult[],
): ResponseRollbackResult {
  return {
    status: "rolledBack",
    responseId,
    stagedCreates: {
      committed: results.flatMap((result) => result.stagedCreates.committed),
      discarded: results.flatMap((result) => result.stagedCreates.discarded),
    },
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

/** The Work's draft this write ensured closed before the write landed. */
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

/** A write the Work's Discard retired before it could be staged; the copy a save receipt uses. */
function discardedWrite(command: WriteCommand, reason: DiscardedWriteReason): WriteOutcome {
  const path = splitDocumentFile(command.file).filePath;
  const message = `Write did not land: ${rejectedWriteExplanation(reason)}. Re-read and retry.`;
  return {
    status: "invalid_write",
    isError: true,
    revision: null,
    command: command.command,
    result: modelResult({
      command: command.command,
      status: "invalid_write",
      payload: { path, message, rejected: reason },
    }),
  };
}

function sameView(a: { kind: string; draftId?: string }, b: LinkView): boolean {
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
