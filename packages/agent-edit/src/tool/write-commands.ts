// Mutating and query write command handlers.
import * as Y from "yjs";

import { snapshotBlocks } from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { writeHandle } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import { withLiveDocument } from "./coordinator.js";
import { interactionContextForAttempt, mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { MutationCommit } from "./mutation-commit.js";
import { status } from "./response-format.js";
import type { WriteCommand, WriteContext } from "./types.js";
import type { WriteToolInternals } from "./write-deps.js";
import {
  agentMeta,
  agentUpdateOrigin,
  BaselineIntegrationError,
  baselineIntegratesBuffered,
  errorMessage,
  errorResponse,
  formatApplySuccess,
  isUnconfirmedDestructiveReplace,
  parseFileAddress,
  readSuccess,
  responseAwareBaselineSnapshot,
  truncateCreateEcho,
} from "./write-helpers.js";
import { scopedToolUseId } from "./write-idempotency.js";

export function createWriteCommands(deps: WriteToolInternals) {
  const {
    options,
    threadOrigins,
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    reversalStore,
    mutationCommit,
    runtimeStore,
    responseCommitter,
  } = deps;
  const { markSynced, requireSynced, runtimeFor } = runtimeStore;

  return { read, create, mutate };

  async function read(
    command: Extract<WriteCommand, { command: "read" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const runtime = runtimeFor(session, address.documentId);

    const stagedUpdates = context.responseId
      ? responseCommitter.bufferedUpdatesForDoc(context.responseId, address.documentId)
      : [];
    const restored = await runtimeStore.restoreRuntimeFromLive(
      session,
      address.documentId,
      runtime,
      command.command,
      { filePath: address.filePath },
    );
    if (isInternalWriteResult(restored)) {
      if (restored.status !== "document_not_found" || stagedUpdates.length === 0) return restored;
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    for (const update of stagedUpdates) {
      Y.applyUpdate(runtime.doc, update, { type: "system" });
    }
    markSynced(session, address.documentId, runtime);

    const selection = renderer.selectReadBlocks(toDocHandle(runtime.doc), command, address);
    if (!selection.ok) return errorResponse(selection.code, selection.message, address.filePath);
    if (command.format === "outline") {
      return readSuccess(
        renderer.renderOutline(toDocHandle(runtime.doc), selection.blocks, address.filePath),
      );
    }
    return readSuccess(renderer.renderBlocks(toDocHandle(runtime.doc), selection.blocks));
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (address.fragment) {
      return status("invalid_write", "create does not accept a #fragment in file.");
    }
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }
    if (context.responseId) {
      responseCommitter.assertCanStage({
        responseId: context.responseId,
        docId: address.documentId,
        session,
        turnId: context.turnId,
        writeId: scopedToolUseId(context, command.tool_use_id ?? context.tool_use_id),
      });
    }

    const runtime = runtimeFor(session, address.documentId);
    const overwriting = command.overwrite === true;
    const parsed = renderer.parseForCommand(command.content ?? "");
    if (!parsed.ok) return status("invalid_write", parsed.message);

    const responseStagedCreate = context.responseId !== undefined;
    if (responseStagedCreate && context.createdDocument === undefined) {
      return status(
        "invalid_write",
        "Staged create requires host-resolved createdDocument ownership metadata.",
      );
    }
    const deferNewDocumentCreation = responseStagedCreate && context.createdDocument === true;
    if (!deferNewDocumentCreation) await options.lifecycle.ensureDocument(address.documentId);
    const liveCheck = await withLiveDocument(
      options.coordinator,
      address.documentId,
      command.command,
      address.filePath,
      (liveDoc) =>
        options.model.getBlocks(toDocHandle(liveDoc)).length > 0 && !overwriting
          ? status(
              "invalid_write",
              `File already exists: ${address.filePath}. Use overwrite=true to overwrite.`,
            )
          : null,
    );
    const missingLiveForDeferredNewDocument =
      deferNewDocumentCreation &&
      isInternalWriteResult(liveCheck) &&
      liveCheck.status === "document_not_found";
    if (isInternalWriteResult(liveCheck) && !missingLiveForDeferredNewDocument) return liveCheck;

    if (!missingLiveForDeferredNewDocument) {
      const restored = await runtimeStore.restoreRuntimeFromLive(
        session,
        address.documentId,
        runtime,
        command.command,
        { filePath: address.filePath },
      );
      if (isInternalWriteResult(restored)) return restored;
    }
    if (missingLiveForDeferredNewDocument) {
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    if (context.responseId) {
      for (const update of responseCommitter.bufferedUpdatesForDoc(
        context.responseId,
        address.documentId,
      )) {
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      }
    }
    const existingBlocks = options.model.getBlocks(toDocHandle(runtime.doc));
    if (existingBlocks.length > 0 && !overwriting) {
      return status(
        "invalid_write",
        `File already exists: ${address.filePath}. Use overwrite=true to overwrite.`,
      );
    }
    const turnId = nextTurnId(session, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(
      address.documentId,
      session,
      context,
      command.tool_use_id,
    );
    const preWriteSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    runtime.doc.transact(() => {
      if (overwriting) {
        options.model.replaceAllBlocks(toDocHandle(runtime.doc), parsed.parsed);
      } else {
        options.model.insertBlocks(toDocHandle(runtime.doc), null, parsed.parsed);
      }
    }, origin);
    const update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      try {
        responseCommitter.stageUpdate({
          responseId: context.responseId,
          docId: address.documentId,
          session,
          runtime,
          commandName: command.command,
          update,
          meta,
          liveOrigin: agentUpdateOrigin(turnId),
          turnId,
          writeId: writeIdentity.handle,
          writeOrdinal: writeIdentity.ordinal,
          durableWriteId: writeIdentity.durableId,
          ensureDocumentBeforeCommit: true,
          createdDocumentBeforeCommit: context.createdDocument === true,
          ...(context.interactionContext ? { interactionContext: context.interactionContext } : {}),
          ...(overwriting ? { updateKind: "replaceAll" } : {}),
        });
      } catch (cause) {
        restorePreWriteSnapshot(runtime, preWriteSnapshot);
        markSynced(session, address.documentId, runtime);
        throw cause;
      }
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        phase: "staged",
        writeId: writeIdentity.handle,
        echo: [
          {
            mode: "truncated",
            blocks: truncateCreateEcho(renderer, runtime.doc, toDocHandle),
          },
        ],
      });
    }

    let committed: Awaited<ReturnType<MutationCommit["commitImmediate"]>>;
    try {
      committed = await mutationCommit.commitImmediate({
        docId: address.documentId,
        commandName: command.command,
        updates: [
          {
            update,
            meta,
            mutation: {
              threadId: session.threadId,
              turnId,
              writeId: writeIdentity.durableId,
              wId: writeIdentity.ordinal,
              ...(overwriting ? { updateKind: "replaceAll" } : {}),
              ...mutationMode(context.interactionContext),
            },
          },
        ],
        afterOwnVector: Y.encodeStateVector(runtime.doc),
        liveOrigin: agentUpdateOrigin(turnId),
        interactionContext: interactionContextForAttempt(
          context.interactionContext,
          undefined,
          writeIdentity.durableId,
        ),
      });
    } catch (cause) {
      restorePreWriteSnapshot(runtime, preWriteSnapshot);
      markSynced(session, address.documentId, runtime);
      throw cause;
    }
    if (!committed.ok) {
      if (committed.journalCommitKind !== "durable") {
        restorePreWriteSnapshot(runtime, preWriteSnapshot);
        markSynced(session, address.documentId, runtime);
        return committed.response;
      }
      await runtimeStore.recoverCommittedResponseProjection([
        { docId: address.documentId, session, runtime, commandName: command.command },
      ]);
    }

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return formatApplySuccess({
      phase: "committed",
      writeId: writeIdentity.handle,
      echo: [
        {
          mode: "truncated",
          blocks: truncateCreateEcho(renderer, runtime.doc, toDocHandle),
        },
      ],
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (context.responseId) {
      responseCommitter.assertCanStage({
        responseId: context.responseId,
        docId: address.documentId,
        session,
        turnId: context.turnId,
        writeId: scopedToolUseId(context, command.tool_use_id ?? context.tool_use_id),
      });
    }
    const runtime = runtimeFor(session, address.documentId);
    let synced = await requireSynced(
      session,
      address.documentId,
      command.command,
      address.filePath,
      runtime,
      { rejectOnStale: isUnconfirmedDestructiveReplace(command, address) },
    );
    if (!synced.ok) return synced.response;
    if (context.interactionContext) {
      const merged = await runtimeStore.syncLocalFromLive(
        session,
        address.documentId,
        runtime,
        command.command,
      );
      if (!merged.ok) return merged.response;
      synced = { ok: true, stateVector: Y.encodeStateVector(runtime.doc) };
    }

    const resolved = resolveWrite(
      { doc: toDocHandle(runtime.doc), model: options.model, codec: options.codec },
      { ...command, documentAddress: address },
    );
    if (!resolved.ok) {
      return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
    }

    const preOwnSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const turnId = nextTurnId(session, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(
      address.documentId,
      session,
      context,
      command.tool_use_id,
    );
    const detectionBaseline = detectionBaselineSnapshot(
      address.documentId,
      context,
      preOwnSnapshot,
    );
    const interactionContext = interactionContextForAttempt(
      context.interactionContext,
      detectionBaseline,
      writeIdentity.durableId,
    );
    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, options.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    const applied = applyEdits(
      toDocHandle(runtime.doc),
      options.model,
      options.codec,
      resolved.edits,
      origin,
      {
        ownActorTurnId: turnId,
        syncStateVector: synced.stateVector,
      },
    );
    if (!applied.ok)
      return errorResponse(applied.error.code, applied.error.message, address.filePath);

    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = agentMeta(turnId);

    if (context.responseId) {
      let concurrent: Awaited<ReturnType<MutationCommit["detectConcurrentEdits"]>> | undefined;
      try {
        concurrent = interactionContext
          ? await mutationCommit.detectConcurrentEdits({
              docId: address.documentId,
              runtime,
              agentUpdate: ownUpdate,
              interactionContext,
              preOwnSnapshot,
              ownTurnId: turnId,
            })
          : undefined;
        responseCommitter.stageUpdate({
          responseId: context.responseId,
          docId: address.documentId,
          session,
          runtime,
          commandName: command.command,
          update: ownUpdate,
          meta,
          liveOrigin: agentUpdateOrigin(turnId),
          turnId,
          writeId: writeIdentity.handle,
          writeOrdinal: writeIdentity.ordinal,
          durableWriteId: writeIdentity.durableId,
          createdDocumentBeforeCommit: false,
          ...(interactionContext ? { interactionContext } : {}),
        });
      } catch (cause) {
        restorePreWriteSnapshot(runtime, preOwnSnapshot);
        markSynced(session, address.documentId, runtime);
        throw cause;
      }
      const summary = mutationCommit.summarizeMutationEcho(
        {
          runtime,
          before,
          touchedHashes: new Set(applied.changedBlocks ?? []),
          deletedHashes: new Set(applied.deletedBlocks ?? []),
        },
        concurrent,
      );
      markSynced(session, address.documentId, runtime);
      return formatApplySuccess({
        phase: "staged",
        writeId: writeIdentity.handle,
        echo: summary.echo,
        concurrentEdits: summary.concurrentEdits,
        deletedBlocks: applied.deletedBlocks,
      });
    }

    let syncedMutation: Awaited<ReturnType<MutationCommit["syncAfterLocalMutation"]>>;
    try {
      syncedMutation = await mutationCommit.syncAfterLocalMutation({
        docId: address.documentId,
        commandName: command.command,
        runtime,
        update: ownUpdate,
        meta,
        mutation: {
          threadId: session.threadId,
          turnId,
          writeId: writeIdentity.durableId,
          wId: writeIdentity.ordinal,
          ...mutationMode(interactionContext),
        },
        afterOwnVector,
        liveOrigin: agentUpdateOrigin(turnId),
        before,
        touchedHashes: new Set(applied.changedBlocks ?? []),
        deletedHashes: new Set(applied.deletedBlocks ?? []),
        ownTurnId: turnId,
        ...(interactionContext ? { interactionContext } : {}),
      });
    } catch (cause) {
      restorePreWriteSnapshot(runtime, preOwnSnapshot);
      markSynced(session, address.documentId, runtime);
      throw cause;
    }
    if (!syncedMutation.ok) {
      if (syncedMutation.journalCommitKind !== "durable") {
        restorePreWriteSnapshot(runtime, preOwnSnapshot);
        markSynced(session, address.documentId, runtime);
        return syncedMutation.response;
      }
      await runtimeStore.recoverCommittedResponseProjection([
        { docId: address.documentId, session, runtime, commandName: command.command },
      ]);
      syncedMutation = {
        ok: true,
        journalCommitKind: "durable",
        summary: mutationCommit.summarizeMutationEcho({
          runtime,
          before,
          touchedHashes: new Set(applied.changedBlocks ?? []),
          deletedHashes: new Set(applied.deletedBlocks ?? []),
        }),
      };
    }

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return formatApplySuccess({
      phase: "committed",
      writeId: writeIdentity.handle,
      echo: syncedMutation.summary.echo,
      concurrentEdits: syncedMutation.summary.concurrentEdits,
      deletedBlocks: applied.deletedBlocks,
    });
  }

  function detectionBaselineSnapshot(
    docId: string,
    context: WriteContext,
    preOwnSnapshot?: Uint8Array,
  ): Uint8Array | undefined {
    const interactionContext = context.interactionContext;
    if (!interactionContext?.baselineSnapshot) return preOwnSnapshot;
    if (!context.responseId) return interactionContext.baselineSnapshot;
    const bufferedUpdates = responseCommitter.bufferedUpdatesForDoc(context.responseId, docId);
    try {
      return responseAwareBaselineSnapshot(interactionContext.baselineSnapshot, bufferedUpdates);
    } catch (cause) {
      const fallback =
        preOwnSnapshot && baselineIntegratesBuffered(preOwnSnapshot, bufferedUpdates)
          ? { snapshot: preOwnSnapshot, to: "preOwnSnapshot" as const }
          : null;
      if (!fallback) {
        throw new BaselineIntegrationError(
          `Staged response updates are not integrable into the cold/request-local detection baselines: ${errorMessage(cause)}`,
          { cause },
        );
      }
      options.onBaselineDegraded?.({
        documentId: docId,
        responseId: context.responseId,
        from: "interaction",
        to: fallback.to,
        reason: errorMessage(cause),
      });
      return fallback.snapshot;
    }
  }

  async function nextWriteIdentity(
    docId: string,
    session: ActorSession,
    context: WriteContext,
    commandToolUseId?: string,
  ): Promise<{ durableId: string; ordinal: number; handle: string }> {
    const ordinal = await reversalStore.reserveWriteOrdinal(docId, session.threadId);
    const durableId =
      scopedToolUseId(context, commandToolUseId ?? context.tool_use_id) ??
      globalThis.crypto?.randomUUID?.() ??
      `${session.threadId}:${docId}:write-${ordinal}`;
    return { durableId, ordinal, handle: writeHandle(ordinal) };
  }

  function nextTurnId(session: ActorSession, docId: string, context: WriteContext): string {
    if (context.turnId) return context.turnId;
    autoTurnCounter.value += 1;
    return `${session.threadId}:${docId}:turn-${autoTurnIdNonce}-${autoTurnCounter.value.toString(36)}`;
  }
}

function restorePreWriteSnapshot(runtime: { doc: Y.Doc }, snapshot: Uint8Array): void {
  const restored = new Y.Doc({ gc: false });
  Y.applyUpdate(restored, snapshot, { type: "system" });
  runtime.doc = restored;
}
