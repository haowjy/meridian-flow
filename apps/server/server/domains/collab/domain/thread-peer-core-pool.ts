/** The one model-edit entry point: routes per document to live or a thread peer, saves each reply once. */
import {
  type AgentEditCore,
  type FrontierLookup,
  modelResult,
  parseDocumentAddress,
  projectSeedFrontier,
  type ReadCommand,
  ResponseAttemptStaleError,
  type ResponseCommitAttempt,
  type ResponseCommitSuccessResult,
  type ResponseRollbackResult,
  type RetiredWriteReason,
  rejectedWriteResult,
  splitDocumentFile,
  type WriteCommand,
  type WriteContext,
  type WriteOutcome,
} from "@meridian/agent-edit/integration";
import type { BranchId, LinkView } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import { FileEditRefusedError, runWithEditGrants } from "../../file-policy/edit-confirmation.js";
import type { FileAccess, FileDestination, FileGrant } from "../../file-policy/index.js";
import {
  asThreadPeerAgentEditCore,
  type LiveAgentEditCore,
  type RefusedResponseDocument,
  type ResponseSaveResult,
  type RoutedReadContext,
  type RoutedWriteContext,
  type RoutedWriteOutcome,
  type ThreadPeerAgentEditCore,
} from "./agent-edit-cores.js";
import { runBoundedAttempts } from "./draft-attempts.js";
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

import type { Branches } from "./branches.js";
import { type EnsuredThreadPeer, peerLossReason } from "./draft-pulls.js";
import { DraftNotFoundError } from "./draft-resolver.js";
import type { DraftSeedRecord } from "./draft-store.js";
import { DraftCasConflictError } from "./draft-store.js";
import { draftRoom } from "./observation-rooms.js";
import type { ApplicationDraftStore } from "./ports/application-draft-store.js";
import {
  pinStaged,
  type ReplyDocument,
  type ReplyRecord,
  type ReplySaveFences,
} from "./reply-save-fences.js";

type ResponseRecord = ReplyRecord;

/** A reply save's commit attempts (section 2.4): four, then the save fails as today. */
const SAVE_ATTEMPTS = 4;

/** A miss the next attempt can resolve: a draft moved, or a buffer changed, since preparing. */
function isSaveAttemptMiss(cause: unknown): boolean {
  return cause instanceof DraftCasConflictError || cause instanceof ResponseAttemptStaleError;
}

/**
 * The single entry point for model reads and writes in both destinations
 * (D19). Each call carries the grant the caller got from the file policy: its
 * destination routes the call, and the write is confirmed under lock where it
 * becomes durable (file-access §5): in the seam's own transaction for a write
 * that commits at once, and once for the whole reply at its save (§5.2).
 */
export function createThreadPeerCorePool(input: {
  branches: Pick<Branches, "viewForWork" | "ensureActiveForWrite" | "shareActive">;
  drafts: Pick<ApplicationDraftStore, "getDraft" | "resolveWorkDraftForThread">;
  removals: DocumentRemovals;
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
  /** A draft-mode write's thread peer, identity only (`DraftPullService.ensureThreadPeer`). */
  ensureThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
  }): Promise<EnsuredThreadPeer>;
  commitThreadResponseAtomically<T>(operation: () => Promise<T>): Promise<T>;
  /**
   * One save attempt's commit scope inside the response transaction: a savepoint, so a
   * miss rolls back every document the attempt wrote and releases the draft rows it took.
   */
  attemptScope<T>(operation: () => Promise<T>): Promise<T>;
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

  /** A core holds only response-scoped state: the LRU bounds committers, never documents. */
  function evictIdleCores(): void {
    while (cores.size > maxThreadCores) {
      const oldest = [...cores.keys()].find(
        (threadId) => ![...responses.values()].some((record) => record.threadId === threadId),
      );
      if (!oldest) break;
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

  function untrackResponse(responseId: string): void {
    responses.delete(responseId);
    evictIdleCores();
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

  function coreForDestination(destination: FileDestination, threadId: string | undefined) {
    return destination.kind === "live" ? input.liveUtilityCore : lookupCore(threadId);
  }

  /**
   * A draft-mode write's identity before its room read (decision 3): the thread's peer,
   * ensured, never read. An existing active peer is returned as is, never replaced.
   */
  async function threadPeerIdentity(
    core: AgentEditCore,
    documentId: DocumentId | null,
    context: WriteContext,
  ): Promise<WriteContext> {
    if (!documentId || !context.threadId || core === input.liveUtilityCore) return context;
    const peer = await input.ensureThreadPeer({
      documentId,
      threadId: context.threadId as ThreadId,
      branchId: context.linkView?.kind === "branch" ? context.linkView.branchId : undefined,
    });
    return {
      ...context,
      frontiers: projectedFrontiers(context.frontiers, peer.upstreamDraftId, peer.seed ?? null),
      interactionContext: {
        mode: "threadPeer" as const,
        peerDraftId: peer.peerDraftId,
        upstreamDraftId: peer.upstreamDraftId,
      },
    };
  }

  function projectedFrontiers(
    frontiers: WriteContext["frontiers"],
    workDraftId: string,
    seed: DraftSeedRecord | null,
  ): WriteContext["frontiers"] {
    if (!frontiers || !seed) return frontiers;
    const targetRoom = draftRoom(workDraftId);
    const origins = new Map(Object.entries(seed.origins));
    const wrap =
      (lookup: FrontierLookup): FrontierLookup =>
      async (room) => {
        const native = await lookup(room);
        if (native || room !== targetRoom) return native;
        return projectSeedFrontier(await lookup(seed.liveRoom), {
          sourceRoom: seed.liveRoom,
          sourceSnapshot: seed.liveSnapshot,
          targetRoom,
          targetSnapshot: seed.draftSnapshot,
          origins,
        });
      };
    return {
      ...frontiers,
      recording: wrap(frontiers.recording),
      ...(frontiers.planning ? { planning: wrap(frontiers.planning) } : {}),
    };
  }

  /** The thread's Work draft of the document a draft read can show, if it has one. */
  async function workDraftFor(documentId: DocumentId, threadId: string): Promise<string | null> {
    try {
      return (await input.drafts.resolveWorkDraftForThread(documentId, threadId as ThreadId))
        .draftId;
    } catch (cause) {
      if (cause instanceof DraftNotFoundError) return null;
      throw cause;
    }
  }

  /**
   * A write that commits at once (a live write with no reply, or a live reversal): the seams
   * it reaches confirm its grant in their own transaction. A refusal is the typed error.
   */
  async function commitNow(
    grant: FileGrant<"edit">,
    write: () => Promise<WriteOutcome>,
  ): Promise<WriteOutcome> {
    const result = await runWithEditGrants(input.fileAccess, [grant], write);
    if (result.ok) return result.value;
    throw result.refusal;
  }

  /**
   * Where a read goes, for a tool read and an effective read alike: the reply's pinned
   * participant with its edit scope (an explicit live read never takes a draft pin), else the
   * thread's core for a draft read of a document the thread has a Work draft of, else live. A
   * read never makes a branch, a draft or a peer (S1). A draft read names the Work draft it
   * resolved, so the core's host reads it without resolving it again.
   */
  async function routeRead(request: {
    documentId: DocumentId | null;
    threadId?: string | null;
    responseId?: string | null;
    version: "live" | "draft";
  }): Promise<{
    core: AgentEditCore;
    pinned?: ReplyDocument;
    scope?: string;
    workDraftId?: string;
  }> {
    const { documentId, threadId, responseId, version } = request;
    const entry =
      documentId && responseId ? responses.get(responseId)?.documents.get(documentId) : undefined;
    if (entry && (version === "draft" || entry.grant.destination.kind === "live"))
      return { core: entry.core, pinned: entry, ...(responseId ? { scope: responseId } : {}) };
    const workDraftId =
      version === "draft" && documentId && threadId
        ? await workDraftFor(documentId, threadId)
        : null;
    return workDraftId && threadId
      ? { core: lookupCore(threadId), workDraftId }
      : { core: input.liveUtilityCore };
  }

  async function read(command: ReadCommand, routed: RoutedReadContext): Promise<WriteOutcome> {
    const { grant, liveVersion, ...context } = routed;
    const version = liveVersion ? "live" : grant.destination.kind;
    const { core, pinned, workDraftId } = await routeRead({
      documentId: documentIdFromCommand(command),
      threadId: context.threadId,
      responseId: context.responseIdentity?.editScopeId,
      version,
    });
    const destination =
      pinned?.grant.destination ??
      (version === "live" ? ({ kind: "live" } as const) : grant.destination);
    evictIdleCores();
    const routedContext = {
      ...(await routedTo(context, destination, pinned?.linkView)),
      ...(workDraftId ? { workDraftId } : {}),
    };
    // An edits read shows history, not the document: it records no frontier.
    const outcome = await core.read(
      command,
      command.format === "edits" ? { ...routedContext, frontiers: undefined } : routedContext,
    );
    if (outcome.isError) return outcome;
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
    const { grant, ...given } = routed;
    const documentId = documentIdFromCommand(command);
    const immediateInverse =
      command.command === "undo" || command.command === "redo" || command.command === "revert";
    // A drafted write with no reply runs as a one-entry reply (amendment 1): the same ensure,
    // pin and lifetime before its room read, then the save's fences, locks and admission.
    const oneEntry =
      !given.responseIdentity?.editScopeId &&
      !immediateInverse &&
      grant.destination.kind === "draft"
        ? {
            providerResponseId: `immediate:${crypto.randomUUID()}`,
            editScopeId: crypto.randomUUID(),
          }
        : undefined;
    const context: WriteContext = oneEntry ? { ...given, responseIdentity: oneEntry } : given;
    const record = context.responseIdentity?.editScopeId
      ? responseFor(context.responseIdentity?.editScopeId, context.threadId)
      : undefined;
    const pinned = documentId ? record?.documents.get(documentId) : undefined;
    // A document keeps its first destination for the rest of the reply, so a
    // mid-reply rebind or branch regeneration never splits it across two saves.
    // The chat's mode can't change mid-reply: it changes only between replies (D62).
    const destination = pinned?.grant.destination ?? grant.destination;
    const core = pinned?.core ?? coreForDestination(destination, context.threadId);
    // Lookup and enrollment are synchronous: close must see the first owner
    // before cache maintenance yields, so that owner's lifecycle rejects late staging.
    record?.participants.add(core);
    evictIdleCores();
    const branchView: LinkView | undefined =
      pinned || destination.kind !== "draft" || immediateInverse
        ? undefined
        : {
            kind: "branch",
            branchId: (
              await input.branches.ensureActiveForWrite({
                workId: destination.workId,
                projectId: grant.facts.projectId,
                threadId: (context.threadId as ThreadId | undefined) ?? null,
                userId: grant.principal.accountId,
              })
            ).id,
          };
    const routedContext = await routedTo(context, destination, pinned?.linkView ?? branchView);
    let entry = pinned;
    if (record && documentId && !pinned && !immediateInverse) {
      entry = { core, grant, linkView: routedContext.linkView };
      record.documents.set(documentId, entry);
    }
    let callContext: WriteContext = routedContext;
    const call = async () => {
      if (!immediateInverse) {
        callContext = await threadPeerIdentity(core, documentId, callContext);
        pinStaged(entry, callContext);
      }
      // A staged write records nothing: its save records in the room the save committed into.
      return core.write(command, callContext);
    };
    // A staged write whose peer lost to Discard all or an item Discard: the same named
    // refusal its save receipt would carry, never the store's raw error.
    const staged = async (): Promise<WriteOutcome> => {
      try {
        return await call();
      } catch (cause) {
        const view = entry?.linkView ?? routedContext.linkView;
        const reason = await peerLossReason(
          input,
          cause,
          view.kind === "branch" ? view.branchId : undefined,
          documentId,
        );
        // The reply's earlier staged writes stay: the retirement refuses them with their own receipts.
        if (!reason) throw cause;
        // An entry this attempt installed and never pinned routes the reply to the closed
        // branch, and retirement matches pins only: drop it so the retry ensures a fresh branch.
        if (record && documentId && entry && entry !== pinned && !entry.pin) {
          if (record.documents.get(documentId) === entry) record.documents.delete(documentId);
        }
        return discardedWrite(command, reason);
      }
    };
    const outcome =
      record && !immediateInverse ? await staged() : await commitNow(pinned?.grant ?? grant, call);
    const settled = oneEntry
      ? await settleOneEntry(command, documentId, outcome, oneEntry.editScopeId, given.frontiers)
      : outcome;
    if (
      !settled.isError &&
      documentId &&
      !context.responseIdentity?.editScopeId &&
      destination.kind === "live"
    )
      input.afterLiveCommit?.(documentId);
    return settled;
  }

  /**
   * A one-entry reply's save, answered as the immediate write it stands for: its settled
   * receipt (or refusal), frontier included. A denial under the save's locks is the typed error
   * an immediate write's seam would throw.
   */
  async function settleOneEntry(
    command: WriteCommand,
    documentId: DocumentId | null,
    staged: WriteOutcome,
    responseId: string,
    frontiers: WriteContext["frontiers"],
  ): Promise<WriteOutcome> {
    const saved = await commitResponse(
      responseId,
      frontiers ? { recordingFrontier: frontiers.recording } : undefined,
    );
    // A write that changed nothing staged nothing: its unchanged result is the answer.
    if (staged.isError || !staged.settlementId) return staged;
    const denial = saved.refused.find(
      (refusal) => refusal.documentId === documentId && "denial" in refusal,
    );
    if (denial && "denial" in denial) throw new FileEditRefusedError([denial.denial]);
    const document = saved.documents.find((entry) => entry.documentId === documentId);
    const receipt = document?.receipts.find((entry) => entry.settlementId === staged.settlementId);
    if (!receipt) throw new Error(`The save of ${command.file} returned no receipt for its write`);
    const result = receipt.result;
    const base = {
      command: staged.command,
      revision: receipt.revision,
      writeId: receipt.writeId,
      result,
      ...(receipt.showing ? { showing: receipt.showing } : {}),
      ...(document?.frontier && result.status === "success" ? { frontier: document.frontier } : {}),
    };
    return result.status === "success"
      ? { ...base, isError: false, status: "success", phase: "committed" }
      : { ...base, isError: true, status: result.status };
  }

  /**
   * Lock once per reply (file-access §5.2): every grant the reply wrote under,
   * confirmed together (its Works locked in id order), then its live
   * documents' mutation locks in id order, before any participant commits. A
   * refused document leaves the reply; the rest saves (D29, D42).
   */
  /** Every participant's save attempt, prepared in order; none survives a failure to prepare. */
  async function prepareAttempts(
    responseId: string,
    participants: readonly AgentEditCore[],
    options: Parameters<AgentEditCore["prepareResponse"]>[1],
    onFailure: "fail" | "quiet" = "fail",
  ): Promise<Map<AgentEditCore, ResponseCommitAttempt>> {
    const attempts = new Map<AgentEditCore, ResponseCommitAttempt>();
    try {
      for (const core of participants)
        attempts.set(core, await core.prepareResponse(responseId, options));
    } catch (cause) {
      if (onFailure === "quiet") {
        for (const attempt of attempts.values()) attempt.dispose();
        throw cause;
      }
      throw await failAttempts(attempts, cause);
    }
    return attempts;
  }

  /** The save fails as a save failure does: every attempt dropped, each core's buffer kept. */
  async function failAttempts(
    attempts: ReadonlyMap<AgentEditCore, ResponseCommitAttempt>,
    cause: unknown,
  ): Promise<unknown> {
    let failure: unknown;
    for (const attempt of attempts.values()) {
      try {
        await attempt.fail(cause);
      } catch (error) {
        failure ??= error;
      }
    }
    return failure ?? cause;
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

  async function retireThreadPeers(
    docId: string,
    peers: readonly {
      threadId: string;
      peerDraftId: string;
      reason: import("@meridian/agent-edit/integration").RetiredWriteReason;
    }[],
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const { threadId, peerDraftId, reason } of peers) {
      if (!docId || !threadId || !peerDraftId)
        throw new Error("Retirement names one document, thread and peer draft");
      const id = threadId as ThreadId;
      for (const record of responses.values()) {
        if (record.threadId !== id) continue;
        for (const core of record.participants) record.receipting.add(core);
        const entry = record.documents.get(docId as DocumentId);
        if (entry?.pin?.peerDraftId === peerDraftId) record.documents.delete(docId as DocumentId);
      }
      // Response-pinned owners survive cache eviction and must lose these buffers too.
      for (const core of new Set([...ownersForThread(id), input.liveUtilityCore])) {
        try {
          await core.retirePeer({ documentId: docId, threadId, peerDraftId, reason });
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
        : await input.branches.viewForWork(destination.workId));
    return { ...context, linkView };
  }

  async function commitResponse(
    responseId: string,
    options?: Parameters<ThreadPeerAgentEditCore["commitResponse"]>[1],
  ): Promise<ResponseSaveResult> {
    const record = responses.get(responseId);
    if (!record) {
      // A reply that wrote nothing has nothing to save; it only closes.
      const closed = await input.liveUtilityCore.commitResponse(responseId);
      const saved = mergeSaveResults(responseId, [closed], []);
      await options?.beforeTransactionCommit?.(saved);
      return saved;
    }
    // A core whose every document was refused has already closed this reply on its
    // side; only a reply that never wrote falls back to the live core, which closes it.
    const wrote = record.participants.size > 0;
    const participantsNow = () => (wrote ? [...record.participants] : [input.liveUtilityCore]);
    // Each saved document records in the room its save committed into.
    const saveOptions = {
      ...finalizeOptions(),
      ...(options?.recordingFrontier ? { recordingFrontier: options.recordingFrontier } : {}),
    };
    // The first attempt is prepared before the transaction opens, off every lock. One
    // that cannot be prepared yet (a document `confirm` will refuse) is prepared again
    // after `confirm`, inside the transaction. Until the first attempt takes it, it is
    // disposed on any unwind, `confirm` throwing included.
    let early: Map<AgentEditCore, ResponseCommitAttempt> | undefined = await prepareAttempts(
      responseId,
      participantsNow(),
      saveOptions,
      "quiet",
    ).catch(() => undefined);
    const takeEarly = (participants: readonly AgentEditCore[]) => {
      const taken = early;
      early = undefined;
      for (const [core, attempt] of taken ?? []) {
        if (participants.includes(core)) continue;
        attempt.dispose();
        taken?.delete(core);
      }
      return taken;
    };
    try {
      return await input.responseTransactions.run(
        input.commitThreadResponseAtomically,
        async () => {
          const refused = await input.fences.confirm(record);
          const participants = participantsNow();
          const results: ResponseCommitSuccessResult[] = [];
          // The attempt a failed save fails with; none once installing began.
          let failing: Map<AgentEditCore, ResponseCommitAttempt> | undefined;
          // One scope per attempt, before its first draft-store lock: a miss on any
          // document unwinds every document's rows, receipts and placements, and the
          // attempts' process-local state is dropped with them (decision D7: `confirm`
          // ran once above and is not replayed; a retry recomputes under its locks).
          try {
            await runBoundedAttempts({
              bound: SAVE_ATTEMPTS,
              scope: input.attemptScope,
              isMiss: isSaveAttemptMiss,
              run: async (attempt) => {
                failing = undefined;
                const attempts =
                  takeEarly(participants) ??
                  (await prepareAttempts(responseId, participants, saveOptions));
                failing = attempts;
                for (const core of participants) {
                  const prepared = attempts.get(core);
                  if (!prepared) continue;
                  attempt.own({
                    async transfer() {
                      failing = undefined;
                      results.push(await prepared.install());
                    },
                    dispose: () => prepared.dispose(),
                  });
                }
                await attempt.commit(async () => {
                  for (const core of participants) await attempts.get(core)?.consume();
                });
              },
              exhausted: (cause) => {
                throw cause;
              },
            });
          } catch (cause) {
            throw failing ? await failAttempts(failing, cause) : cause;
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
      );
    } finally {
      takeEarly([]);
    }
  }

  return asThreadPeerAgentEditCore({
    read,
    write,
    refuseStaged(responseId, docId, reason, peerDraftId) {
      const record = responses.get(responseId);
      for (const core of record?.participants ?? []) {
        core.refuseStaged(responseId, docId, reason, peerDraftId);
        record?.receipting.add(core);
      }
      const entry = record?.documents.get(docId as DocumentId);
      if (entry && (!peerDraftId || entry.pin?.peerDraftId === peerDraftId))
        record?.documents.delete(docId as DocumentId);
    },
    retirePeer: ({ documentId, threadId, peerDraftId, reason }) =>
      retireThreadPeers(documentId, [{ threadId, peerDraftId, reason }]),
    commitResponse,
    hasResponseDocument(responseId, docId) {
      const pinned = responses.get(responseId)?.documents.get(docId as DocumentId);
      return pinned?.core.hasResponseDocument(responseId, docId) ?? false;
    },
    async readRoom({ documentId, threadId, responseId, live }) {
      const { core, scope, workDraftId } = await routeRead({
        documentId,
        threadId,
        responseId,
        version: live ? "live" : "draft",
      });
      return core.readRoom(documentId, {
        threadId: threadId ?? "",
        ...(scope ? { responseId: scope } : {}),
        ...(workDraftId ? { workDraftId } : {}),
      });
    },
    async rollbackResponse(responseId) {
      const record = responses.get(responseId);
      return input.responseTransactions.run(
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
    },
    retireThreadPeers,
    dropStaged(docId, threadId) {
      if (!docId || !threadId) throw new Error("dropStaged names one document and one thread");
      for (const core of new Set([...ownersForThread(threadId as ThreadId), input.liveUtilityCore]))
        core.dropStaged(docId, threadId);
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

/** A write the Work's Discard retired before it could be staged; the copy a save receipt uses. */
function discardedWrite(command: WriteCommand, reason: RetiredWriteReason): WriteOutcome {
  const path = splitDocumentFile(command.file).filePath;
  return {
    status: "invalid_write",
    isError: true,
    revision: null,
    command: command.command,
    result: modelResult({
      command: command.command,
      status: "invalid_write",
      payload: { path, ...rejectedWriteResult(reason).model },
    }),
  };
}

function documentIdFromCommand(command: { file: string; documentId?: string }): DocumentId | null {
  const address = parseDocumentAddress(command.file, command.documentId);
  return address.ok ? (address.documentId as DocumentId) : null;
}
