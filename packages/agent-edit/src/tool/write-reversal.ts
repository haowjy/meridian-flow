// Runs write-level undo/redo from durable journal reconstruction.
import * as Y from "yjs";
import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import type { ConcurrentUpdateOrigin } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentCoordinator } from "../ports/document-coordinator.js";
import type { AgentEditModel } from "../ports/model.js";
import type { ReversalActor, ReversalRecord } from "../ports/types.js";
import {
  type JournalCommitKind,
  parseWriteHandle,
  type ReversalStore,
} from "../ports/update-journal.js";
import { resolveUndoAvailability, type UndoAvailability } from "../undo/availability.js";
import { reconstructUndoUpdateFromSnapshot } from "../undo/reconstruction.js";
import {
  planRedo,
  planUndo,
  type ReversalPlan,
  type ReversalSelection,
} from "../undo/reversal-plan.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import { withLiveDocument } from "./coordinator.js";
import type { InternalWriteResult, WriteResultBlock } from "./internal-result.js";
import type {
  DestructiveSweepReport,
  MutationCommit,
  SyncedMutationSummary,
} from "./mutation-commit.js";
import { formatConcurrent, status, toOutcome } from "./response-format.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type {
  InteractionContext,
  MutationActor,
  UndoRedoOutcome,
  WriteCommand,
  WriteRedoResult,
  WriteUndoResult,
} from "./types.js";

export interface ReversalNoticePort {
  record(input: {
    threadId: string;
    writeHandles: string[];
    writeHandleTurns: readonly { writeHandle: string; turnId: string | null }[];
    docId: string;
    direction: "undo" | "redo";
    sweptContent: boolean;
    beforeContentRef: number | null;
  }): Promise<void>;
  recordLateSweep?(input: {
    threadId: string;
    docId: string;
    direction: "undo" | "redo";
    report: DestructiveSweepReport;
  }): Promise<void>;
}

export interface ReversalNoticeFailedDetail {
  threadId: string;
  docId: string;
  representativeTurnId: string | null | undefined;
  direction: "undo" | "redo";
  writeHandleCount: number;
  cause: string;
}

export interface WriteReversal {
  run(input: WriteReversalRunInput): Promise<InternalWriteResult>;
  runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "undo" },
  ): Promise<WriteUndoResult>;
  runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "redo" },
  ): Promise<WriteRedoResult>;
  getAvailability(docId: string, threadId: string): Promise<UndoAvailability>;
}

export interface WriteReversalRunInput {
  docId: string;
  session: ActorSession;
  commandName: WriteCommand["command"];
  direction: "undo" | "redo";
  selection: ReversalSelection;
  actor?: ReversalActor;
  interactionContext?: InteractionContext;
}

export interface WriteReversalEndpointInput {
  docId: string;
  session: ActorSession;
  direction: "undo" | "redo";
  selection?: ReversalSelection;
  actor?: ReversalActor;
  interactionContext?: InteractionContext;
}

type ReversalResult =
  | {
      ok: true;
      status: UndoRedoOutcome;
      sync?: SyncedMutationSummary;
      targetCount?: number;
      turnId?: string | null;
      scopeTurnId?: string;
    }
  | { ok: false; response: InternalWriteResult };

export function createWriteReversal(deps: {
  reversalStore: ReversalStore;
  coordinator: DocumentCoordinator;
  runtimeStore: RuntimeStore;
  mutationCommit: MutationCommit;
  model: AgentEditModel;
  codec: AgentEditCodec;
  undoClientId?: number;
  reversalNoticePort?: ReversalNoticePort;
  onReversalNoticeFailed?: (event: ReversalNoticeFailedDetail) => void;
  onInvariantViolation?: (message: string) => void;
}): WriteReversal {
  const {
    reversalStore,
    runtimeStore,
    mutationCommit,
    model,
    codec,
    undoClientId,
    onInvariantViolation = defaultInvariantViolation,
  } = deps;

  return {
    run,
    runWriteReversal,
    getAvailability,
  };

  async function getAvailability(docId: string, threadId: string): Promise<UndoAvailability> {
    const availability = await resolveUndoAvailability({
      reversalStore,
      docId,
      threadId,
    });
    return {
      undo: availability.undo,
      redo: availability.redo,
      ...(availability.undoWriteId ? { undoWriteId: availability.undoWriteId } : {}),
      ...(availability.undoTarget ? { undoTarget: availability.undoTarget } : {}),
      ...(availability.redoWriteId ? { redoWriteId: availability.redoWriteId } : {}),
    };
  }

  async function run(input: WriteReversalRunInput): Promise<InternalWriteResult> {
    const actor = input.actor ?? { type: "agent" as const };
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const interaction = await reversalInteractionContext({ ...input, actor, runtime });
    if (!interaction.ok) return interaction.response;
    const synced = await runtimeStore.syncLocalFromLive(
      input.session,
      input.docId,
      runtime,
      input.direction,
    );
    if (!synced.ok) return synced.response;
    return runUndoOrRedo({
      ...input,
      actor,
      runtime,
      interactionContext: interaction.context,
    });
  }

  function runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "undo" },
  ): Promise<WriteUndoResult>;
  function runWriteReversal(
    input: WriteReversalEndpointInput & { direction: "redo" },
  ): Promise<WriteRedoResult>;
  async function runWriteReversal(
    input: WriteReversalEndpointInput,
  ): Promise<WriteUndoResult | WriteRedoResult> {
    const actor = input.actor ?? { type: "agent" as const };
    const previousRuntime = runtimeStore.runtimeFor(input.session, input.docId);
    const interaction = await reversalInteractionContext({
      ...input,
      actor,
      runtime: previousRuntime,
    });
    if (!interaction.ok) {
      return toOutcome(input.direction, interaction.response) as WriteUndoResult | WriteRedoResult;
    }

    await invalidateRuntimeThread(input.docId, input.session.threadId);
    const runtime = runtimeStore.runtimeFor(input.session, input.docId);
    const synced = await runtimeStore.syncLocalFromLive(
      input.session,
      input.docId,
      runtime,
      input.direction,
    );
    const result = !synced.ok
      ? synced.response
      : await runUndoOrRedo({
          docId: input.docId,
          session: input.session,
          runtime,
          commandName: input.direction,
          direction: input.direction,
          selection: input.selection ?? { kind: "latest" },
          actor,
          interactionContext: interaction.context,
        });
    if (result.status !== "document_not_found") {
      await runtimeStore.evictThreadRuntimes(input.docId, input.session.threadId);
    }
    return toOutcome(input.direction, result) as WriteUndoResult | WriteRedoResult;
  }

  async function reversalInteractionContext(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    actor: ReversalActor;
    interactionContext?: InteractionContext;
  }): Promise<
    { ok: true; context: InteractionContext } | { ok: false; response: InternalWriteResult }
  > {
    if (input.interactionContext) return { ok: true, context: input.interactionContext };

    const snapshot = await reversalStore.readForReconstruction(input.docId);
    return {
      ok: true,
      context: {
        mode: "live",
        liveJournalSeq: snapshot.updates.reduce(
          (latest, update) => Math.max(latest, update.seq),
          0,
        ),
      },
    };
  }

  async function runUndoOrRedo(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    selection: ReversalSelection;
    actor: ReversalActor;
    interactionContext: InteractionContext;
  }): Promise<InternalWriteResult> {
    const prepared = await prepareReversals(input);
    if (!prepared.ok) return prepared.response;
    if (prepared.plans.length === 0) return status(prepared.emptyStatus);

    const reversal = await executePrepared({ ...input, plans: prepared.plans });
    if (!reversal.ok) return reversal.response;
    if (reversal.sync) runtimeStore.markSynced(input.session, input.docId, input.runtime);

    const metaLines = [`status: ${reversal.status}`];
    if (reversal.targetCount > 0)
      metaLines.push(`${input.direction}: ${reversal.targetCount} edit(s)`);
    if (reversal.sync.concurrentEdits)
      metaLines.push(...formatConcurrent(reversal.sync.concurrentEdits));

    const echoLines = reversal.sync.echo
      .flatMap((hunk) => hunk.blocks)
      .filter((line) => line.length > 0);
    const content: WriteResultBlock[] = [{ type: "text", text: metaLines.join("\n") }];
    if (echoLines.length > 0) content.push({ type: "text", text: echoLines.join("\n") });
    return {
      status: reversal.status,
      text: content.map((block) => block.text).join("\n\n"),
      content,
    };
  }

  type PreparedReversal = {
    plan: Extract<ReversalPlan, { ok: true }>;
    update: Uint8Array;
    ownDiff: ReturnType<typeof diffSnapshots>;
  };

  async function prepareReversals(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    direction: "undo" | "redo";
    selection: ReversalSelection;
    actor: ReversalActor;
  }): Promise<
    | { ok: true; plans: PreparedReversal[]; emptyStatus: "nothing_to_undo" | "nothing_to_redo" }
    | { ok: false; response: InternalWriteResult }
  > {
    const plans: PreparedReversal[] = [];
    const excludedRedoGroups = new Set<number>();
    const excludedUndoWrites = new Set<string>();
    let selection = input.selection;

    while (true) {
      const prepared = await prepareOne({
        ...input,
        selection,
        excludedRedoGroups,
        excludedUndoWrites,
        priorUpdates: plans.map((prepared) => prepared.update),
      });
      if (!prepared.ok) return prepared;
      if (!prepared.prepared) break;
      plans.push(prepared.prepared);
      if (plans.length === 1) selection = resolvedScopeSelection(selection, prepared.prepared.plan);
      const undoUpdateSeq = prepared.prepared.plan.redoGroup?.undoUpdateSeq;
      if (undoUpdateSeq !== undefined) excludedRedoGroups.add(undoUpdateSeq);
      for (const writeId of prepared.prepared.plan.writeIds) excludedUndoWrites.add(writeId);
      if (!isScopeSelection(selection)) break;
    }

    return {
      ok: true,
      plans,
      emptyStatus: input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
    };
  }

  async function prepareOne(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    direction: "undo" | "redo";
    selection: ReversalSelection;
    actor: ReversalActor;
    excludedRedoGroups: ReadonlySet<number>;
    excludedUndoWrites: ReadonlySet<string>;
    priorUpdates: readonly Uint8Array[];
  }): Promise<
    { ok: true; prepared?: PreparedReversal } | { ok: false; response: InternalWriteResult }
  > {
    const threadId = input.session.threadId;
    const plan = await (input.direction === "undo"
      ? planUndo({
          reversalStore,
          docId: input.docId,
          threadId,
          selection: input.selection,
          excludeWriteIds: input.excludedUndoWrites,
        })
      : planRedo({
          reversalStore,
          docId: input.docId,
          threadId,
          selection: input.selection,
          excludeUndoUpdateSeqs: input.excludedRedoGroups,
        }));
    if (!plan.ok) {
      if (plan.status === "cant_undo_dependent") {
        return {
          ok: false,
          response: status(
            plan.status,
            plan.message ??
              formatDependentUndoRefusal(
                plan.selectedWriteIds ?? [],
                plan.blockingWriteIds ?? ["a later edit"],
              ),
          ),
        };
      }
      if (plan.status === "invalid_write") {
        return { ok: false, response: status("invalid_write", plan.message) };
      }
      return { ok: true };
    }

    const sourceDoc = cloneDocWithUpdates(input.runtime.doc, input.priorUpdates);
    const reconstructionPlan = withPriorReversalUpdates(plan, input.priorUpdates);
    const before = snapshotBlocks(toDocHandle(sourceDoc), model, codec);
    let update: Uint8Array;
    try {
      if (input.direction === "undo") {
        const cold = reconstructUndoUpdateFromSnapshot(reconstructionPlan.snapshot, {
          docId: input.docId,
          targetId: formatWriteSelection(plan.writeIds),
          targetSeqs: plan.targetSeqs,
          undoClientId,
        });
        update = repairUndoTextOrder({
          source: sourceDoc,
          undoUpdate: cold.undoUpdate,
          plan: reconstructionPlan,
          model,
        });
      } else {
        const undoUpdateSeq = plan.redoGroup?.undoUpdateSeq;
        if (undoUpdateSeq === undefined) return { ok: true };
        update = reconstructUndoUpdateFromSnapshot(reconstructionPlan.snapshot, {
          docId: input.docId,
          targetId: `redo ${formatWriteSelection(plan.writeIds)}`,
          targetSeqs: new Set([undoUpdateSeq]),
          undoClientId,
        }).undoUpdate;
      }
    } catch (cause) {
      sourceDoc.destroy();
      return surfaceColdReversalInvariant({
        direction: input.direction,
        writeIds: plan.writeIds,
        detail: {
          docId: input.docId,
          threadId,
          turnId: plan.turnId,
          undoUpdateSeq: plan.redoGroup?.undoUpdateSeq,
        },
        cause,
      });
    }
    if (!effectiveYjsUpdate(sourceDoc, update)) {
      sourceDoc.destroy();
      return { ok: true };
    }

    const preview = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(preview, Y.encodeStateAsUpdate(sourceDoc), { type: "system" });
      Y.applyUpdate(preview, update, reversalOrigin(input.actor, plan));
      return {
        ok: true,
        prepared: {
          plan,
          update,
          ownDiff: diffSnapshots(before, snapshotBlocks(toDocHandle(preview), model, codec)),
        },
      };
    } finally {
      preview.destroy();
      sourceDoc.destroy();
    }
  }

  function resolvedScopeSelection(
    selection: ReversalSelection,
    first: Extract<ReversalPlan, { ok: true }>,
  ): ReversalSelection {
    if (
      selection.kind !== "turn" ||
      selection.turnId !== undefined ||
      first.scopeTurnId === undefined
    ) {
      return selection;
    }
    return { kind: "turn", turnId: first.scopeTurnId };
  }

  function isScopeSelection(selection: ReversalSelection): boolean {
    return selection.kind === "turn" || selection.kind === "all";
  }

  async function executePrepared(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
    direction: "undo" | "redo";
    actor: ReversalActor;
    interactionContext: InteractionContext;
    plans: PreparedReversal[];
  }): Promise<
    | {
        ok: true;
        status: "reversed" | "reconciled";
        sync: SyncedMutationSummary;
        targetCount: number;
      }
    | { ok: false; response: InternalWriteResult }
  > {
    const before = snapshotBlocks(toDocHandle(input.runtime.doc), model, codec);
    const update = Y.mergeUpdates(input.plans.map((prepared) => prepared.update));
    const deletedHashes = new Set(input.plans.flatMap(({ ownDiff }) => [...ownDiff.deleted]));
    const touchedHashes = new Set(
      input.plans.flatMap(({ ownDiff }) => [...ownDiff.changed, ...ownDiff.inserted]),
    );

    let journalCommitKind: JournalCommitKind | undefined;
    let mutation: SyncedMutationSummary | InternalWriteResult | null;
    try {
      mutation = await withLiveDocument(
        deps.coordinator,
        input.docId,
        input.commandName,
        input.docId,
        async (liveDoc) => {
          const first = input.plans[0];
          if (!first) throw new Error("Prepared reversal group must not be empty");
          const capturedPreflight = await mutationCommit.captureCommitPreflight(liveDoc, {
            docId: input.docId,
            runtime: input.runtime,
            actor: reversalMutationActor(input.actor, input.session, first.plan),
            deletedHashes: first.ownDiff.deleted,
            touchedHashes: new Set([...first.ownDiff.changed, ...first.ownDiff.inserted]),
            interactionContext: input.interactionContext,
            preOwnSnapshot: Y.encodeStateAsUpdate(input.runtime.doc),
            ownTurnId: first.plan.turnId ?? undefined,
          });

          const persisted = await persistPlans({ ...input, update });
          if (!persisted.ok) return persisted.response ?? null;
          journalCommitKind = persisted.journalCommitKind;

          let applied: Awaited<ReturnType<MutationCommit["applyCommittedUpdateWithRecheck"]>>;
          try {
            applied = await mutationCommit.applyCommittedUpdateWithRecheck(
              liveDoc,
              {
                docId: input.docId,
                runtime: input.runtime,
                actor: reversalMutationActor(input.actor, input.session, first.plan),
                deletedHashes,
                touchedHashes,
                interactionContext: input.interactionContext,
                preOwnSnapshot: Y.encodeStateAsUpdate(input.runtime.doc),
                ownTurnId: first.plan.turnId ?? undefined,
                update,
                liveOrigin: reversalOrigin(input.actor, first.plan),
              },
              capturedPreflight,
            );
          } catch (cause) {
            if (persisted.journalCommitKind !== "durable") throw cause;
            await recoverDurableReversal(input, cause);
            return { echo: [], reconciled: false };
          }
          const lateSweep = applied.lateSweep;
          for (const concurrent of applied.concurrent.updates) {
            if (concurrent.update.length > 0) {
              Y.applyUpdate(input.runtime.doc, concurrent.update, concurrent.origin);
            }
          }
          Y.applyUpdate(input.runtime.doc, update, reversalOrigin(input.actor, first.plan));

          const sweptContent = lateSweep !== undefined;
          if (lateSweep) {
            await recordLateSweep({
              threadId: input.session.threadId,
              docId: input.docId,
              direction: input.direction,
              report: lateSweep,
            });
          }
          if (input.actor.type === "user") {
            for (const prepared of input.plans) {
              await recordReversalNotice({
                threadId: input.session.threadId,
                writeHandles: [...prepared.plan.writeIds],
                writeHandleTurns: prepared.plan.writeTurnIds,
                docId: input.docId,
                direction: input.direction,
                sweptContent,
                beforeContentRef: sweptContent
                  ? (input.interactionContext.liveJournalSeq ?? null)
                  : null,
              });
            }
          }

          const summary = mutationCommit.summarizeMutationEcho(
            {
              runtime: input.runtime,
              before,
              touchedHashes,
              deletedHashes,
            },
            applied.concurrent.detection,
          );
          return sweptContent ? { ...summary, reconciled: true } : summary;
        },
      );
    } catch (cause) {
      if (journalCommitKind === "durable") {
        await recoverDurableReversal(input, cause);
        return {
          ok: true,
          status: "reversed",
          sync: { echo: [], reconciled: false },
          targetCount: input.plans.reduce(
            (count, prepared) => count + prepared.plan.writeIds.length,
            0,
          ),
        };
      }
      if (journalCommitKind === "staged") await restoreAfterRejectedStagedReversal(input);
      throw cause;
    }
    if (mutation && "status" in mutation) return { ok: false, response: mutation };
    if (!mutation) {
      return {
        ok: false,
        response: status(input.direction === "undo" ? "nothing_to_undo" : "nothing_to_redo"),
      };
    }
    return {
      ok: true,
      status: mutation.reconciled ? "reconciled" : "reversed",
      sync: mutation,
      targetCount: input.plans.reduce(
        (count, prepared) => count + prepared.plan.writeIds.length,
        0,
      ),
    };
  }

  function surfaceColdReversalInvariant(input: {
    direction: "undo" | "redo";
    writeIds: readonly string[];
    detail: { docId: string; threadId: string; turnId: string | null; undoUpdateSeq?: number };
    cause: unknown;
  }): ReversalResult {
    const safeWrite = input.writeIds.length === 1 ? ` for ${input.writeIds[0]}` : "";
    const detail = [
      `Cold ${input.direction} reconstruction invariant failed for document ${input.detail.docId}, thread ${input.detail.threadId}, write(s) ${input.writeIds.join(", ")}`,
      input.detail.undoUpdateSeq === undefined
        ? undefined
        : `undo update seq ${input.detail.undoUpdateSeq}`,
      `turn ${input.detail.turnId}`,
      formatCause(input.cause),
    ]
      .filter(Boolean)
      .join(": ");
    onInvariantViolation(detail);
    return {
      ok: false,
      response: status("internal_error", `Retry — transient edit system failure${safeWrite}.`),
    };
  }

  async function persistPlans(input: {
    docId: string;
    session: ActorSession;
    direction: "undo" | "redo";
    plans: PreparedReversal[];
    update: Uint8Array;
    actor: ReversalActor;
  }): Promise<
    | { ok: true; journalCommitKind: JournalCommitKind }
    | { ok: false; response?: InternalWriteResult }
  > {
    if (input.direction === "undo") {
      const first = input.plans[0];
      if (!first) return { ok: false };
      const turnByHandle = new Map(
        input.plans.flatMap(({ plan }) =>
          plan.writeTurnIds.map((entry) => [entry.writeHandle, entry.turnId] as const),
        ),
      );
      const persistGuardWatermark = first.plan.snapshot.updates.reduce(
        (max, update) => Math.max(max, update.seq),
        0,
      );
      const records: ReversalRecord[] = input.plans.flatMap(({ plan }) =>
        plan.writeIds.map((writeId) => ({
          documentId: input.docId,
          turnId: turnByHandle.get(writeId) ?? plan.turnId,
          threadId: input.session.threadId,
          writeIds: [writeId],
          status: "reversed",
          undoUpdateSeq: 0,
          reversedAt: new Date(),
          persistGuardWatermark,
          ...(input.actor.type === "user"
            ? { reversedByUserId: input.actor.userId }
            : input.actor.responseId
              ? { authoringResponseId: input.actor.responseId }
              : {}),
        })),
      );
      const persisted = await reversalStore.persistUndo(
        input.docId,
        input.update,
        records,
        input.actor,
      );
      if (!persisted.persisted) {
        return {
          ok: false,
          response: status(persisted.status, persisted.message),
        };
      }
      return {
        ok: true,
        journalCommitKind: persisted.journalCommitKind ?? "durable",
      };
    }
    const entries = input.plans.flatMap((prepared) => {
      const undoUpdateSeq = prepared.plan.redoGroup?.undoUpdateSeq;
      return undoUpdateSeq === undefined
        ? []
        : [
            {
              update: prepared.update,
              ref: { threadId: input.session.threadId, undoUpdateSeq },
              persistGuardWatermark: prepared.plan.snapshot.updates.reduce(
                (max, update) => Math.max(max, update.seq),
                0,
              ),
              meta: {
                origin: "system",
                reversalActor: input.actor,
                ...(input.actor.type === "agent" && input.actor.responseId
                  ? { authoringResponseId: input.actor.responseId }
                  : {}),
                seq: 0,
              },
            },
          ];
    });
    if (entries.length !== input.plans.length) return { ok: false };
    const consumed = await reversalStore.persistRedoBatch(input.docId, entries);
    if (!consumed.consumed) return { ok: false };
    return {
      ok: true,
      journalCommitKind: consumed.journalCommitKind ?? "durable",
    };
  }

  async function recoverDurableReversal(
    input: {
      docId: string;
      session: ActorSession;
      runtime: RuntimeDocumentState;
      commandName: WriteCommand["command"];
    },
    cause: unknown,
  ): Promise<void> {
    reportRecoveredInvariant(
      `Durable reversal projection failed for ${input.docId}; recovering committed journal state: ${formatCause(cause)}`,
    );
    try {
      await runtimeStore.recoverCommittedResponseProjection([
        {
          docId: input.docId,
          session: input.session,
          runtime: input.runtime,
          commandName: input.commandName,
        },
      ]);
    } catch (recoveryCause) {
      reportRecoveredInvariant(
        `Durable reversal recovery failed for ${input.docId}; committed effect will be replayed on next access: ${formatCause(recoveryCause)}`,
      );
      await runtimeStore.evictThreadRuntimes(input.docId, input.session.threadId, {
        markLiveDocStale: true,
      });
    }
  }

  async function restoreAfterRejectedStagedReversal(input: {
    docId: string;
    session: ActorSession;
    runtime: RuntimeDocumentState;
    commandName: WriteCommand["command"];
  }): Promise<void> {
    try {
      const response = await runtimeStore.restoreRuntimeFromLive(
        input.session,
        input.docId,
        input.runtime,
        input.commandName,
      );
      if (!response) return;
    } catch {
      // Eviction below makes the next attempt rebuild from the unchanged branch.
    }
    await runtimeStore.evictThreadRuntimes(input.docId, input.session.threadId);
  }

  function reportRecoveredInvariant(message: string): void {
    try {
      onInvariantViolation(message);
    } catch {
      // The reversal is already durable. Diagnostics must not turn its honest
      // committed outcome back into a retryable-looking failure.
    }
  }

  async function recordReversalNotice(input: Parameters<ReversalNoticePort["record"]>[0]) {
    try {
      await deps.reversalNoticePort?.record(input);
    } catch (cause) {
      const event: ReversalNoticeFailedDetail = {
        threadId: input.threadId,
        docId: input.docId,
        representativeTurnId: representativeTurnId(input.writeHandleTurns),
        direction: input.direction,
        writeHandleCount: input.writeHandles.length,
        cause: formatCause(cause),
      };
      if (deps.onReversalNoticeFailed) {
        deps.onReversalNoticeFailed(event);
        return;
      }
      console.error("agent-edit undo notification recording failed", event);
    }
  }

  async function recordLateSweep(
    input: Parameters<NonNullable<ReversalNoticePort["recordLateSweep"]>>[0],
  ) {
    try {
      await deps.reversalNoticePort?.recordLateSweep?.(input);
    } catch (cause) {
      const event: ReversalNoticeFailedDetail = {
        threadId: input.threadId,
        docId: input.docId,
        representativeTurnId: null,
        direction: input.direction,
        writeHandleCount: input.report.affectedBlockHashes.length,
        cause: formatCause(cause),
      };
      if (deps.onReversalNoticeFailed) {
        deps.onReversalNoticeFailed(event);
        return;
      }
      console.error("agent-edit late-sweep notification recording failed", event);
    }
  }

  async function invalidateRuntimeThread(docId: string, threadId: string): Promise<void> {
    await runtimeStore.evictThreadRuntimes(docId, threadId, { markLiveDocStale: true });
  }
}

function representativeTurnId(
  writeHandleTurns: readonly { writeHandle: string; turnId: string | null }[],
): string | null | undefined {
  return writeHandleTurns[0]?.turnId;
}

function reversalOrigin(
  actor: ReversalActor,
  plan: Extract<ReversalPlan, { ok: true }> | undefined,
): ConcurrentUpdateOrigin {
  return actor.type === "user"
    ? { type: "human", userId: actor.userId }
    : { type: "agent", actorTurnId: plan?.turnId ?? "reversal" };
}

function reversalMutationActor(
  actor: ReversalActor,
  session: ActorSession,
  plan: Extract<ReversalPlan, { ok: true }> | undefined,
): MutationActor {
  if (actor.type === "user") {
    return { kind: "human", userId: actor.userId, threadId: session.threadId };
  }
  const turnId = plan?.turnId ?? "reversal";
  return {
    kind: "agent",
    turnId,
    threadId: session.threadId,
    ...(actor.responseId ? { responseId: actor.responseId } : {}),
  };
}

function formatDependentUndoRefusal(
  selectedWriteIds: readonly string[],
  blockingWriteIds: readonly string[],
): string {
  const selected = formatWriteSelection(selectedWriteIds);
  const blockers = formatWriteList(blockingWriteIds);
  const pronoun = selectedWriteIds.length === 1 ? "it" : "that range";
  const remedyRange = dependentUndoRemedyRange(selectedWriteIds, blockingWriteIds);
  const remedy = remedyRange
    ? `Undo ${blockers} first, or undo the range ${remedyRange}.`
    : `Undo ${blockers} first, or undo the dependent range together.`;
  return `Can't undo ${selected} on its own — ${blockers} was built on ${pronoun}. ${remedy}`;
}

function dependentUndoRemedyRange(
  selectedWriteIds: readonly string[],
  blockingWriteIds: readonly string[],
): string | undefined {
  const ordinals = [...selectedWriteIds, ...blockingWriteIds]
    .map((handle) => (isWriteHandle(handle) ? parseWriteHandle(handle) : undefined))
    .filter((ordinal): ordinal is number => ordinal !== undefined);
  if (ordinals.length !== selectedWriteIds.length + blockingWriteIds.length) return undefined;
  const min = Math.min(...ordinals);
  const max = Math.max(...ordinals);
  return min === max ? `w${min}` : `w${min}..w${max}`;
}

function formatWriteSelection(writeIds: readonly string[]): string {
  if (writeIds.length === 0) return "that edit";
  if (writeIds.length === 1) return writeIds[0] ?? "that edit";
  const ordinals = writeIds.map((handle) => parseWriteHandle(handle));
  const allOrdinals = ordinals.every((ordinal): ordinal is number => ordinal !== undefined);
  if (allOrdinals) {
    const sorted = [...ordinals].sort((left, right) => left - right);
    const contiguous = sorted.every(
      (ordinal, index) => index === 0 || ordinal === sorted[index - 1] + 1,
    );
    if (contiguous) return `w${sorted[0]}..w${sorted.at(-1)}`;
  }
  return formatWriteList(writeIds);
}

function formatWriteList(writeIds: readonly string[]): string {
  if (writeIds.length <= 1) return writeIds[0] ?? "a later edit";
  if (writeIds.length === 2) return `${writeIds[0]} and ${writeIds[1]}`;
  return `${writeIds.slice(0, -1).join(", ")}, and ${writeIds.at(-1)}`;
}

function isWriteHandle(handle: string): boolean {
  return parseWriteHandle(handle) !== undefined;
}

function formatCause(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : String(cause);
}

function defaultInvariantViolation(message: string): never {
  throw new Error(message);
}

function repairUndoTextOrder(input: {
  source: Y.Doc;
  undoUpdate: Uint8Array;
  plan: Extract<ReversalPlan, { ok: true }>;
  model: AgentEditModel;
}): Uint8Array {
  const targetSeqs = [...input.plan.targetSeqs].sort((left, right) => left - right);
  const firstTargetSeq = targetSeqs[0];
  const lastTargetSeq = targetSeqs.at(-1);
  if (firstTargetSeq === undefined || lastTargetSeq === undefined) return input.undoUpdate;

  const base = docFromSnapshot(input.plan.snapshot, { untilSeqExclusive: firstTargetSeq });
  const target = docFromSnapshot(input.plan.snapshot, { untilSeqInclusive: lastTargetSeq });
  const repaired = cloneDoc(input.source);
  Y.applyUpdate(repaired, input.undoUpdate, { type: "system" });
  const beforeRepairState = Y.encodeStateVector(repaired);

  let changed = false;
  for (const repair of textOrderRepairs({
    base,
    target,
    current: input.source,
    repaired,
    model: input.model,
  })) {
    input.model.transact(
      toDocHandle(repaired),
      () =>
        input.model.applyTextEdit(toDocHandle(repaired), repair.block, repair.span, repair.text),
      { type: "system" },
    );
    changed = true;
  }

  if (!changed) return input.undoUpdate;
  return Y.mergeUpdates([input.undoUpdate, Y.encodeStateAsUpdate(repaired, beforeRepairState)]);
}

function textOrderRepairs(input: {
  base: Y.Doc;
  target: Y.Doc;
  current: Y.Doc;
  repaired: Y.Doc;
  model: AgentEditModel;
}): Array<{
  block: ReturnType<AgentEditModel["getBlocks"]>[number];
  span: { from: number; to: number };
  text: string;
}> {
  const baseBlocks = blockTextMap(input.base, input.model);
  const targetBlocks = blockTextMap(input.target, input.model);
  const currentBlocks = blockTextMap(input.current, input.model);
  const repairedBlocks = blockRefMap(input.repaired, input.model);
  const repairs: Array<{
    block: ReturnType<AgentEditModel["getBlocks"]>[number];
    span: { from: number; to: number };
    text: string;
  }> = [];

  for (const [hash, baseText] of baseBlocks) {
    const targetText = targetBlocks.get(hash);
    const currentText = currentBlocks.get(hash);
    const repairedBlock = repairedBlocks.get(hash);
    if (targetText === undefined || currentText === undefined || !repairedBlock) continue;
    if (!hasSinglePlainRun(repairedBlock, input.model)) continue;

    const edit = simpleReplacement(baseText, targetText);
    if (!edit || edit.inserted.length === 0 || edit.deleted.length === 0) continue;
    if (!currentText.startsWith(edit.prefix) || !currentText.endsWith(edit.suffix)) continue;

    const middle = currentText.slice(edit.prefix.length, currentText.length - edit.suffix.length);
    const insertedAt = middle.lastIndexOf(edit.inserted);
    if (insertedAt < 0) continue;
    const expectedText = `${edit.prefix}${middle.slice(0, insertedAt)}${edit.deleted}${middle.slice(
      insertedAt + edit.inserted.length,
    )}${edit.suffix}`;
    const repairedText = input.model.getText(repairedBlock);
    if (repairedText === expectedText) continue;
    repairs.push({
      block: repairedBlock,
      span: { from: 0, to: repairedText.length },
      text: expectedText,
    });
  }

  return repairs;
}

function docFromSnapshot(
  snapshot: Extract<ReversalPlan, { ok: true }>["snapshot"],
  options: { untilSeqExclusive?: number; untilSeqInclusive?: number },
): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const update of snapshot.updates) {
    if (options.untilSeqExclusive !== undefined && update.seq >= options.untilSeqExclusive) break;
    if (options.untilSeqInclusive !== undefined && update.seq > options.untilSeqInclusive) break;
    Y.applyUpdate(doc, update.update);
  }
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

function cloneDocWithUpdates(source: Y.Doc, updates: readonly Uint8Array[]): Y.Doc {
  const doc = cloneDoc(source);
  for (const update of updates) Y.applyUpdate(doc, update, { type: "system" });
  return doc;
}

function withPriorReversalUpdates(
  plan: Extract<ReversalPlan, { ok: true }>,
  updates: readonly Uint8Array[],
): Extract<ReversalPlan, { ok: true }> {
  if (updates.length === 0) return plan;
  const maxSeq = plan.snapshot.updates.reduce((latest, update) => Math.max(latest, update.seq), 0);
  return {
    ...plan,
    snapshot: {
      ...plan.snapshot,
      updates: [
        ...plan.snapshot.updates,
        ...updates.map((update, index) => ({
          seq: maxSeq + index + 1,
          update,
          meta: { origin: "system", seq: maxSeq + index + 1 },
        })),
      ],
    },
  };
}

function blockTextMap(doc: Y.Doc, model: AgentEditModel): Map<string, string> {
  return new Map(
    model
      .getBlocks(toDocHandle(doc))
      .map((block) => [model.getBlockId(block), model.getText(block)]),
  );
}

function blockRefMap(
  doc: Y.Doc,
  model: AgentEditModel,
): Map<string, ReturnType<AgentEditModel["getBlocks"]>[number]> {
  return new Map(
    model.getBlocks(toDocHandle(doc)).map((block) => [model.getBlockId(block), block]),
  );
}

function hasSinglePlainRun(
  block: ReturnType<AgentEditModel["getBlocks"]>[number],
  model: AgentEditModel,
): boolean {
  return model.inlineRuns(block).length <= 1;
}

function simpleReplacement(
  before: string,
  after: string,
): { prefix: string; deleted: string; inserted: string; suffix: string } | undefined {
  if (before === after) return undefined;
  let prefixLength = 0;
  while (
    prefixLength < before.length &&
    prefixLength < after.length &&
    before[prefixLength] === after[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength &&
    suffixLength < after.length - prefixLength &&
    before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return {
    prefix: before.slice(0, prefixLength),
    deleted: before.slice(prefixLength, before.length - suffixLength),
    inserted: after.slice(prefixLength, after.length - suffixLength),
    suffix: suffixLength === 0 ? "" : before.slice(before.length - suffixLength),
  };
}
