// Mutating and query write command handlers.
import * as Y from "yjs";

import { snapshotBlocks } from "../apply/echo.js";
import { applyEdits } from "../apply/tiers.js";
import { toDocHandle } from "../handles.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { writeHandle } from "../ports/update-journal.js";
import { resolveWrite } from "../resolver/resolve.js";
import type { ThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { withLiveDocument } from "./coordinator.js";
import type { DocumentRenderer } from "./document-renderer.js";
import { interactionContextForAttempt, mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { MutationCommit } from "./mutation-commit.js";
import type { ResponseCommitter } from "./response-committer.js";
import { formatApplySuccess, status, truncateCreateEcho } from "./response-format.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { MutationActor, WriteCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import {
  errorResponse,
  isUnconfirmedDestructiveReplace,
  mutationMeta,
  mutationUpdateOrigin,
  parseFileAddress,
  readSuccess,
} from "./write-helpers.js";
import { scopedToolUseId } from "./write-idempotency.js";

export function createWriteCommands(deps: {
  options: Pick<
    CreateWriteToolOptions,
    "model" | "codec" | "lifecycle" | "createRuntimeDoc" | "coordinator"
  >;
  threadOrigins: ThreadOriginRegistry;
  autoTurnCounter: { value: number };
  autoTurnIdNonce: string;
  renderer: DocumentRenderer;
  reversalStore: CreateWriteToolOptions["journal"];
  mutationCommit: MutationCommit;
  runtimeStore: RuntimeStore;
  responseCommitter: ResponseCommitter;
}) {
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
    const selected = new Set(selection.blocks);
    const observations = snapshotBlocks(toDocHandle(runtime.doc), options.model, options.codec)
      .filter((_, index) => selected.has(options.model.getBlocks(toDocHandle(runtime.doc))[index]))
      .flatMap((block) =>
        block.clientID !== undefined && block.clock !== undefined && block.renderedContent
          ? [
              {
                kind: "rendered" as const,
                clientID: block.clientID,
                clock: block.clock,
                renderedContent: block.renderedContent,
                sourceText: block.serialized,
              },
            ]
          : [],
      );
    if (command.format === "outline") {
      return {
        ...readSuccess(
          renderer.renderOutline(toDocHandle(runtime.doc), selection.blocks, address.filePath),
        ),
        observations,
      };
    }
    return {
      ...readSuccess(renderer.renderBlocks(toDocHandle(runtime.doc), selection.blocks)),
      observations,
    };
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const actor = mutationActor(session, address.documentId, context);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    if (address.fragment) {
      return status("invalid_write", "create does not accept a #fragment in file.");
    }
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }
    if (context.responseId && actor.kind === "agent") {
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

    const responseStagedCreate = context.responseId !== undefined && actor.kind === "agent";
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
    if (context.responseId && actor.kind === "agent") {
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
    const writeIdentity = await nextWriteIdentity(
      address.documentId,
      session,
      context,
      command.tool_use_id,
    );
    const preWriteSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    let touchedHashes = new Set<string>();
    let deletedHashes = new Set<string>();
    if (overwriting && existingBlocks.length > 0) {
      const resolved = resolveWrite(
        { doc: toDocHandle(runtime.doc), model: options.model, codec: options.codec },
        {
          command: "replace",
          documentAddress: address,
          content: command.content ?? "",
          in: [1, existingBlocks.length],
        },
      );
      if (!resolved.ok) {
        return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
      }
      const applied = applyEdits(
        toDocHandle(runtime.doc),
        options.model,
        options.codec,
        resolved.edits,
        origin,
        { ...(turnId ? { ownActorTurnId: turnId } : {}) },
      );
      if (!applied.ok) {
        restorePreWriteSnapshot(runtime, preWriteSnapshot);
        return errorResponse(applied.error.code, applied.error.message, address.filePath);
      }
      touchedHashes = new Set(applied.changedBlocks ?? []);
      deletedHashes = new Set(applied.deletedBlocks ?? []);
    } else {
      runtime.doc.transact(() => {
        options.model.insertBlocks(toDocHandle(runtime.doc), null, parsed.parsed);
      }, origin);
    }
    const update = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = mutationMeta(actor);

    if (context.responseId && actor.kind === "agent") {
      try {
        const rejected = responseCommitter.stageUpdate({
          responseId: context.responseId,
          docId: address.documentId,
          session,
          runtime,
          commandName: command.command,
          update,
          meta,
          liveOrigin: mutationUpdateOrigin(actor),
          actor,
          turnId: actor.turnId,
          writeId: writeIdentity.handle,
          writeOrdinal: writeIdentity.ordinal,
          durableWriteId: writeIdentity.durableId,
          toolCallId: command.tool_use_id ?? context.tool_use_id,
          ensureDocumentBeforeCommit: true,
          createdDocumentBeforeCommit: context.createdDocument === true,
          touchedHashes,
          deletedHashes,
          preOwnSnapshot: preWriteSnapshot,
          ...(context.interactionContext ? { interactionContext: context.interactionContext } : {}),
        });
        if (rejected) {
          restorePreWriteSnapshot(runtime, preWriteSnapshot);
          markSynced(session, address.documentId, runtime);
          return rejected;
        }
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
        runtime,
        updates: [
          {
            update,
            meta,
            mutation: {
              threadId: session.threadId,
              turnId,
              ...(actor.kind === "agent" ? { authoringResponseId: actor.responseId } : {}),
              actorKind: actor.kind,
              ...(actor.kind === "human" ? { userId: actor.userId } : {}),
              ...(actor.kind === "system" ? { systemOrigin: actor.origin } : {}),
              writeId: writeIdentity.durableId,
              wId: writeIdentity.ordinal,
              ...mutationMode(context.interactionContext),
            },
          },
        ],
        afterOwnVector: Y.encodeStateVector(runtime.doc),
        liveOrigin: mutationUpdateOrigin(actor),
        actor,
        touchedHashes,
        deletedHashes,
        preOwnSnapshot: preWriteSnapshot,
        ...(turnId ? { turnId } : {}),
        interactionContext: interactionContextForAttempt(
          context.interactionContext,
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
        await runtimeStore.evictRuntime(session, address.documentId);
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
      ...(committed.ok && committed.lateSweep ? { lateSweep: committed.lateSweep } : {}),
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
    const actor = mutationActor(session, address.documentId, context);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    const writeIdentity = await nextWriteIdentity(
      address.documentId,
      session,
      context,
      command.tool_use_id,
    );
    const interactionContext = interactionContextForAttempt(
      context.interactionContext,
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
        ...(turnId ? { ownActorTurnId: turnId } : {}),
        syncStateVector: synced.stateVector,
      },
    );
    if (!applied.ok)
      return errorResponse(applied.error.code, applied.error.message, address.filePath);

    const afterOwnVector = Y.encodeStateVector(runtime.doc);
    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = mutationMeta(actor);

    if (context.responseId && actor.kind === "agent") {
      try {
        const concurrent = interactionContext
          ? await mutationCommit.detectConcurrentEdits({
              docId: address.documentId,
              runtime,
              agentUpdate: ownUpdate,
              interactionContext,
              preOwnSnapshot,
              ...(turnId ? { ownTurnId: turnId } : {}),
            })
          : undefined;
        const summary = mutationCommit.summarizeMutationEcho(
          {
            runtime,
            before,
            touchedHashes: new Set(applied.changedBlocks ?? []),
            deletedHashes: new Set(applied.deletedBlocks ?? []),
          },
          concurrent,
        );
        const result = formatApplySuccess({
          phase: "staged",
          writeId: writeIdentity.handle,
          echo: summary.echo,
          concurrentEdits: summary.concurrentEdits,
          deletedBlocks: applied.deletedBlocks,
        });
        const rejected = responseCommitter.stageUpdate({
          responseId: context.responseId,
          docId: address.documentId,
          session,
          runtime,
          commandName: command.command,
          update: ownUpdate,
          meta,
          liveOrigin: mutationUpdateOrigin(actor),
          actor,
          turnId: actor.turnId,
          writeId: writeIdentity.handle,
          writeOrdinal: writeIdentity.ordinal,
          durableWriteId: writeIdentity.durableId,
          toolCallId: command.tool_use_id ?? context.tool_use_id,
          createdDocumentBeforeCommit: false,
          touchedHashes: new Set(applied.changedBlocks ?? []),
          deletedHashes: new Set(applied.deletedBlocks ?? []),
          preOwnSnapshot,
          ...(interactionContext ? { interactionContext } : {}),
        });
        if (rejected) {
          restorePreWriteSnapshot(runtime, preOwnSnapshot);
          markSynced(session, address.documentId, runtime);
          return rejected;
        }
        markSynced(session, address.documentId, runtime);
        return result;
      } catch (cause) {
        restorePreWriteSnapshot(runtime, preOwnSnapshot);
        markSynced(session, address.documentId, runtime);
        throw cause;
      }
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
          ...(actor.kind === "agent" ? { authoringResponseId: actor.responseId } : {}),
          actorKind: actor.kind,
          ...(actor.kind === "human" ? { userId: actor.userId } : {}),
          ...(actor.kind === "system" ? { systemOrigin: actor.origin } : {}),
          writeId: writeIdentity.durableId,
          wId: writeIdentity.ordinal,
          ...mutationMode(interactionContext),
        },
        afterOwnVector,
        liveOrigin: mutationUpdateOrigin(actor),
        actor,
        before,
        touchedHashes: new Set(applied.changedBlocks ?? []),
        deletedHashes: new Set(applied.deletedBlocks ?? []),
        ...(turnId ? { ownTurnId: turnId } : {}),
        preOwnSnapshot,
        ...(interactionContext ? { interactionContext } : {}),
      });
    } catch (cause) {
      restorePreWriteSnapshot(runtime, preOwnSnapshot);
      markSynced(session, address.documentId, runtime);
      throw cause;
    }
    if (!syncedMutation.ok) {
      if (syncedMutation.journalCommitKind !== "durable") {
        await runtimeStore.evictRuntime(session, address.documentId);
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
      ...(syncedMutation.lateSweep ? { lateSweep: syncedMutation.lateSweep } : {}),
    });
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

  function mutationActor(
    session: ActorSession,
    docId: string,
    context: WriteContext,
  ): MutationActor {
    if (context.actor) return context.actor;
    const turnId = nextTurnId(session, docId, context);
    return {
      kind: "agent",
      turnId,
      threadId: session.threadId,
      responseId: context.responseId ?? turnId,
    };
  }
}

function restorePreWriteSnapshot(runtime: { doc: Y.Doc }, snapshot: Uint8Array): void {
  const restored = new Y.Doc({ gc: false });
  Y.applyUpdate(restored, snapshot, { type: "system" });
  runtime.doc = restored;
}
