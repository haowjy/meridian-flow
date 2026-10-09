// Mutating and query write command handlers.
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { diffSnapshots, snapshotBlocks } from "../apply/echo.js";
import { resolveOverwrite } from "../apply/overwrite.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import { type BlockRef, toDocHandle } from "../handles.js";
import { createWriteLinkAssigner, type WriteLinkAssigner } from "../links/assign-refs.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { writeHandle } from "../ports/update-journal.js";
import { documentRevision, planWrite, type ResolveWriteResult } from "../resolver/resolve.js";
import { type SemanticEditIRV1, validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
import type { ThreadOriginRegistry } from "../undo/thread-origin-registry.js";
import { withLiveDocument } from "./coordinator.js";
import { copyEdgeLines, copySummary } from "./copy-receipt.js";
import type { DocumentRenderer, ParseForCommandResult } from "./document-renderer.js";
import { interactionContextForAttempt, mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import { type BoundLinks, bindLinks } from "./link-binding.js";
import {
  AcceptedMutationSubmissionError,
  type MutationCommit,
  type PreparedMutation,
} from "./mutation-commit.js";
import {
  mergePreparedUpdate,
  type PreparedUpdate,
  preparedRefusalResult,
} from "./prepared-update.js";
import type { ResponseCommitter } from "./response-committer.js";
import {
  formatApplySuccess,
  formatUnchangedSuccess,
  isDocumentEmpty,
  status,
  truncateCreateEcho,
} from "./response-format.js";
import type { RuntimeDocumentState, RuntimeStore } from "./runtime-store.js";
import type { MutationActor, ReadCommand, WriteCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import {
  errorResponse,
  mutationMeta,
  mutationUpdateOrigin,
  parseFileAddress,
  readSuccess,
} from "./write-helpers.js";
import { scopedToolUseId } from "./write-idempotency.js";

export function createWriteCommands(deps: {
  options: Pick<
    CreateWriteToolOptions,
    | "model"
    | "codec"
    | "lifecycle"
    | "createRuntimeDoc"
    | "coordinator"
    | "semanticProvenance"
    | "links"
    | "onLinkSpliceFallback"
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

  return { read, create, mutate, applyPrepared };

  function emptiedDocument(
    runtime: { doc: Y.Doc },
    codec: AgentEditCodec,
  ): { documentEmpty?: true } {
    return isDocumentEmpty(options.model, codec, toDocHandle(runtime.doc))
      ? { documentEmpty: true }
      : {};
  }

  async function read(
    command: ReadCommand,
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
      "read",
    );
    if (isInternalWriteResult(restored)) {
      if (restored.status !== "document_not_found" || stagedUpdates.length === 0) return restored;
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    for (const update of stagedUpdates) {
      Y.applyUpdate(runtime.doc, update, { type: "system" });
    }
    const links = await bindLinks(options, {
      documentId: address.documentId,
      docs: [runtime.doc],
      context,
    });
    markSynced(session, address.documentId);

    const selection = renderer.selectReadBlocks(toDocHandle(runtime.doc), command, address);
    if (!selection.ok)
      return errorResponse(
        selection.code,
        selection.message,
        address.filePath,
        selection.documentBlocks,
      );
    return withShown(links, {
      ...readSuccess(
        renderer.renderRead(
          toDocHandle(runtime.doc),
          links.codec,
          selection.blocks,
          command.format === "outline" ? "outline" : "full",
        ),
      ),
      revision: options.links.revision(runtime.doc, links.scope),
      ...(context.includeNodes ? { nodes: selectedNodes(runtime.doc, selection.blocks) } : {}),
    });
  }

  /** The selected blocks as nodes, in document order; a copy gets fresh identity when inserted. */
  function selectedNodes(doc: Y.Doc, selected: readonly BlockRef[]): Block[] {
    const handle = toDocHandle(doc);
    const nodes = options.model.projectBlocks(handle);
    const indexByBlock = new Map(
      options.model.getBlocks(handle).map((block, index) => [block, index]),
    );
    return selected.flatMap((block) => {
      const index = indexByBlock.get(block);
      const node = index === undefined ? undefined : nodes[index];
      return node ? [node] : [];
    });
  }

  /**
   * `create`, and `copy`, which is a create whose content is the source's
   * blocks as nodes (D24): same write handle, rollback, undo and drafting.
   */
  async function create(
    command: Extract<WriteCommand, { command: "create" | "copy" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const actor = mutationActor(session, address.documentId, context);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    if (address.fragment) {
      return status("invalid_write", `${command.command} does not accept a #fragment in file.`);
    }
    const copiedNodes = command.command === "copy" ? context.copiedNodes : undefined;
    if (command.command === "copy" && !copiedNodes) {
      return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    }
    const content = command.command === "create" ? (command.content ?? "") : "";
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
    const parsed: ParseForCommandResult = copiedNodes
      ? { ok: true, parsed: { blocks: [...copiedNodes] } }
      : renderer.parseForCommand(content);
    if (!parsed.ok) return status("invalid_write", parsed.message);

    const responseStagedCreate = context.responseId !== undefined && actor.kind === "agent";
    if (responseStagedCreate && context.createdDocument === undefined) {
      return status(
        "invalid_write",
        "Staged create requires host-resolved createdDocument ownership metadata.",
      );
    }
    const deferNewDocumentCreation = responseStagedCreate && context.createdDocument === true;
    const bufferedResponseUpdates =
      context.responseId && actor.kind === "agent"
        ? responseCommitter.bufferedUpdatesForDoc(context.responseId, address.documentId)
        : [];
    const overwriting =
      command.overwrite === true ||
      (deferNewDocumentCreation && bufferedResponseUpdates.length === 0);
    if (!deferNewDocumentCreation) await options.lifecycle.ensureDocument(address.documentId);
    const liveCheck = await withLiveDocument(
      options.coordinator,
      address.documentId,
      command.command,
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
      );
      if (isInternalWriteResult(restored)) return restored;
    }
    if (missingLiveForDeferredNewDocument) {
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    if (context.responseId && actor.kind === "agent") {
      for (const update of bufferedResponseUpdates) {
        Y.applyUpdate(runtime.doc, update, { type: "system" });
      }
    }
    const shown = copiedNodes ? [] : await shownLinksFor(address.documentId, context);
    const links = await bindLinks(options, {
      documentId: address.documentId,
      docs: [runtime.doc],
      ...(copiedNodes ? { stored: copiedNodes } : { written: parsed.parsed.blocks }),
      shown,
      context,
    });
    const assigner = linkAssigner(address.documentId, links.scope, shown);
    const existingBlocks = options.model.getBlocks(toDocHandle(runtime.doc));
    if (existingBlocks.length > 0 && !overwriting) {
      return status(
        "invalid_write",
        `File already exists: ${address.filePath}. Use overwrite=true to overwrite.`,
      );
    }
    let overwrite: Extract<ResolveWriteResult, { ok: true }> | undefined;
    if (overwriting && existingBlocks.length > 0) {
      const resolved = resolveOverwrite(
        {
          doc: toDocHandle(runtime.doc),
          model: options.model,
          codec: links.codec,
          links: assigner,
        },
        address,
        copiedNodes ? { blocks: copiedNodes } : { content, parsedContent: parsed.parsed },
        copiedNodes ? copiedNodes.length === 0 : content.length === 0,
      );
      if (!resolved.ok) {
        return errorResponse(
          resolved.error.code,
          resolved.error.message,
          address.filePath,
          documentBlocksDetail(resolved.error.details),
        );
      }
      if (resolved.edits.length === 0) return formatUnchangedSuccess();
      overwrite = resolved;
    }
    // Copies carry what they name; written content into an empty document binds fresh.
    const written =
      copiedNodes || overwrite
        ? parsed.parsed
        : { blocks: assigner.bindSpan([], parsed.parsed.blocks) };
    await registerMinted(assigner, address.documentId, context);
    const writeIdentity = await nextWriteIdentity(
      address.documentId,
      session,
      context,
      command.tool_use_id,
    );
    const preWriteSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    let touchedHashes = new Set<string>();
    let deletedHashes = new Set<string>();
    let insertedHashes: string[] = [];
    let semanticEditIr: SemanticEditIRV1 | undefined;
    if (overwrite) {
      semanticEditIr = overwrite.ir;
      const applied = applyEdits(toDocHandle(runtime.doc), options.model, overwrite.edits, origin);
      if (!applied.ok) {
        restorePreWriteSnapshot(runtime, preWriteSnapshot);
        return errorResponse(applied.error.code, applied.error.message, address.filePath);
      }
      writeCertifiedProvenance(runtime, overwrite.ir, beforeVector, preWriteSnapshot);
      touchedHashes = new Set(applied.changedBlocks);
      deletedHashes = new Set(applied.deletedBlocks);
      insertedHashes = applied.insertedBlocks;
    } else {
      runtime.doc.transact(() => {
        insertedHashes = options.model
          .insertBlocks(toDocHandle(runtime.doc), null, written)
          .map((block) => options.model.getBlockId(block));
      }, origin);
    }
    const copied = copiedNodes
      ? copySummary(command.command === "copy" ? command.from.path : "", insertedHashes, {
          edges: false,
        })
      : undefined;
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
          ensureDocumentBeforeCommit: true,
          createdDocumentBeforeCommit: context.createdDocument === true,
          touchedHashes,
          deletedHashes,
          preOwnSnapshot: preWriteSnapshot,
          ...(semanticEditIr ? { semanticEditIr } : {}),
          ...(copied ? { copied } : {}),
          ...(context.interactionContext ? { interactionContext: context.interactionContext } : {}),
        });
        if (rejected) {
          restorePreWriteSnapshot(runtime, preWriteSnapshot);
          markSynced(session, address.documentId);
          return rejected;
        }
      } catch (cause) {
        restorePreWriteSnapshot(runtime, preWriteSnapshot);
        markSynced(session, address.documentId);
        throw cause;
      }
      markSynced(session, address.documentId);
      const summary = mutationCommit.summarizeMutationEcho({
        runtime,
        links,
        before,
        touchedHashes,
        deletedHashes,
      });
      return withShown(
        links,
        formatApplySuccess({
          ...emptiedDocument(runtime, links.codec),
          phase: "staged",
          writeId: writeIdentity.handle,
          settlementId: writeIdentity.durableId,
          echo:
            summary.echo.length > 0
              ? summary.echo
              : [
                  {
                    mode: "truncated",
                    blocks: truncateCreateEcho(renderer, links.codec, runtime.doc, toDocHandle),
                  },
                ],
          concurrentEdits: summary.concurrentEdits,
          ...(copied ? { copied: { summary: copied, edges: [] } } : {}),
        }),
      );
    }

    const committed = await submitPreparedMutation(
      {
        docId: address.documentId,
        commandName: command.command,
        runtime,
        links,
        before,
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
              ...(semanticEditIr ? { semanticEditIr } : {}),
              ...mutationMode(context.interactionContext),
            },
          },
        ],
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
      },
      session,
    );
    if (!committed.ok) {
      if (committed.journalCommitKind !== "durable") {
        return committed.response;
      }
    }

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return withShown(
      links,
      formatApplySuccess({
        ...emptiedDocument(runtime, links.codec),
        phase: "committed",
        revision: committed.ok ? committed.revision : null,
        writeId: writeIdentity.handle,
        echo:
          committed.ok && committed.summary.echo.length > 0
            ? committed.summary.echo
            : [
                {
                  mode: "truncated",
                  blocks: truncateCreateEcho(renderer, links.codec, runtime.doc, toDocHandle),
                },
              ],
        ...(committed.ok && committed.summary.concurrentEdits
          ? { concurrentEdits: committed.summary.concurrentEdits }
          : {}),
        ...(committed.ok && committed.lateSweep ? { lateSweep: committed.lateSweep } : {}),
        ...(committed.awarenessDegraded ? { awarenessDegraded: true } : {}),
        ...(copied ? { copied: { summary: copied, edges: [] } } : {}),
      }),
    );
  }

  /**
   * A whole-document write the host bound and lowered outside its transaction
   * (§6.2), recorded as the actor's mutation: nothing is parsed, assigned or
   * aligned again. It stages on the runtime, and the commit admits it under
   * the document's lock (`admitPreparedUpdate`), never later: it is never
   * part of a staged reply.
   */
  async function applyPrepared(
    input: PreparedUpdate & { documentId: string },
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const { documentId } = input;
    await options.lifecycle?.ensureDocument(documentId);
    const runtime = runtimeFor(session, documentId);
    const restored = await runtimeStore.restoreRuntimeFromLive(
      session,
      documentId,
      runtime,
      "create",
    );
    if (isInternalWriteResult(restored)) return restored;
    const links = await bindLinks(options, { documentId, docs: [runtime.doc], context });
    const preWriteSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(documentId, session.threadId);
    if (!mergePreparedUpdate(runtime.doc, input, origin, true)) {
      restorePreWriteSnapshot(runtime, preWriteSnapshot);
      return preparedRefusalResult(documentId, "base_missing");
    }
    if (sameBytes(Y.encodeStateAsUpdate(runtime.doc), preWriteSnapshot)) {
      return formatUnchangedSuccess();
    }
    // The echo spells what the result names.
    await options.links.prepare({ documentId, docs: [runtime.doc], context });
    const changes = diffSnapshots(
      before,
      snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec),
    );
    const actor = mutationActor(session, documentId, context);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    const writeIdentity = await nextWriteIdentity(documentId, session, context);
    const semanticEditIr = input.certified?.ir;
    const committed = await submitPreparedMutation(
      {
        docId: documentId,
        commandName: "create",
        runtime,
        links,
        before,
        updates: [
          {
            update: Y.encodeStateAsUpdate(runtime.doc, beforeVector),
            meta: mutationMeta(actor),
            mutation: {
              threadId: session.threadId,
              turnId,
              ...(actor.kind === "agent" ? { authoringResponseId: actor.responseId } : {}),
              actorKind: actor.kind,
              ...(actor.kind === "human" ? { userId: actor.userId } : {}),
              ...(actor.kind === "system" ? { systemOrigin: actor.origin } : {}),
              writeId: writeIdentity.durableId,
              wId: writeIdentity.ordinal,
              ...(semanticEditIr ? { semanticEditIr } : {}),
              ...mutationMode(context.interactionContext),
            },
          },
        ],
        liveOrigin: mutationUpdateOrigin(actor),
        actor,
        touchedHashes: new Set([...changes.changed, ...changes.inserted]),
        deletedHashes: changes.deleted,
        preOwnSnapshot: preWriteSnapshot,
        prepared: input,
        ...(turnId ? { turnId } : {}),
        interactionContext: interactionContextForAttempt(
          context.interactionContext,
          writeIdentity.durableId,
        ),
      },
      session,
    );
    if (!committed.ok && committed.journalCommitKind !== "durable") return committed.response;
    runtimeStore.attachRuntime(session, documentId, runtime);
    return formatApplySuccess({
      phase: "committed",
      revision: committed.ok ? committed.revision : null,
      writeId: writeIdentity.handle,
      echo: committed.ok ? committed.summary.echo : [],
      ...(committed.ok && committed.lateSweep ? { lateSweep: committed.lateSweep } : {}),
      ...(committed.awarenessDegraded ? { awarenessDegraded: true } : {}),
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" | "remove" }>,
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
    const synced = await requireSynced(session, address.documentId, command.command, runtime);
    if (!synced.ok) return synced.response;
    if (context.interactionContext) {
      const merged = await runtimeStore.syncLocalFromLive(
        session,
        address.documentId,
        runtime,
        command.command,
      );
      if (!merged.ok) return merged.response;
    }

    const from = command.command === "remove" ? undefined : command.from;
    const copiedNodes = from ? context.copiedNodes : undefined;
    if (from && !copiedNodes) return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    if (copiedNodes?.length === 0) {
      return status("invalid_write", `from selected no blocks in ${from?.path}.`);
    }
    const { from: _from, ...selectors } = command as typeof command & { from?: unknown };
    const shown = copiedNodes ? [] : await shownLinksFor(address.documentId, context);
    const links = await bindLinks(options, {
      documentId: address.documentId,
      docs: [runtime.doc],
      ...(copiedNodes ? { stored: copiedNodes } : {}),
      shown,
      context,
    });
    // Planning fixes scope, matches and a find's reconstructed groups; what
    // binding will see is only known then, so it loads before binding runs.
    const plan = planWrite(
      { doc: toDocHandle(runtime.doc), model: options.model, codec: links.codec },
      {
        ...selectors,
        documentAddress: address,
        ...(copiedNodes ? { blocks: copiedNodes } : {}),
      },
    );
    if (plan.ok && plan.written.length > 0) {
      await options.links.prepare({
        documentId: address.documentId,
        docs: [],
        written: plan.written,
        context,
      });
    }
    const assigner = linkAssigner(address.documentId, links.scope, shown);
    const resolved = plan.ok ? plan.bind(assigner) : plan;
    if (!resolved.ok) {
      return errorResponse(
        resolved.error.code,
        resolved.error.message,
        address.filePath,
        documentBlocksDetail(resolved.error.details),
      );
    }
    validateResolvedIr(resolved.ir, address.documentId, runtime.doc);
    if (resolved.edits.length === 0) return formatUnchangedSuccess();
    await registerMinted(assigner, address.documentId, context);

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
    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = threadOrigins.getThreadOrigin(address.documentId, session.threadId);
    const applied = applyEdits(toDocHandle(runtime.doc), options.model, resolved.edits, origin);
    if (!applied.ok) {
      restorePreWriteSnapshot(runtime, preOwnSnapshot);
      return errorResponse(applied.error.code, applied.error.message, address.filePath);
    }
    writeCertifiedProvenance(runtime, resolved.ir, beforeVector, preOwnSnapshot);
    const copied =
      from && copiedNodes
        ? copySummary(from.path, applied.insertedBlocks, { edges: true })
        : undefined;
    const copiedEcho = () =>
      copied
        ? {
            copied: {
              summary: copied,
              edges: copyEdgeLines(
                copied,
                snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec),
              ),
            },
          }
        : {};

    const ownUpdate = Y.encodeStateAsUpdate(runtime.doc, beforeVector);
    const meta = mutationMeta(actor);

    if (context.responseId && actor.kind === "agent") {
      try {
        const concurrent = interactionContext
          ? await mutationCommit.detectConcurrentEdits({
              docId: address.documentId,
              runtime,
              links,
              agentUpdate: ownUpdate,
              interactionContext,
              preOwnSnapshot,
              ...(turnId ? { ownTurnId: turnId } : {}),
            })
          : undefined;
        const summary = mutationCommit.summarizeMutationEcho(
          {
            runtime,
            links,
            before,
            touchedHashes: new Set(applied.changedBlocks),
            deletedHashes: new Set(applied.deletedBlocks),
          },
          concurrent,
        );
        const result = formatApplySuccess({
          ...emptiedDocument(runtime, links.codec),
          phase: "staged",
          writeId: writeIdentity.handle,
          settlementId: writeIdentity.durableId,
          echo: summary.echo,
          concurrentEdits: summary.concurrentEdits,
          deletedBlocks: applied.deletedBlocks,
          ...copiedEcho(),
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
          createdDocumentBeforeCommit: false,
          touchedHashes: new Set(applied.changedBlocks),
          deletedHashes: new Set(applied.deletedBlocks),
          preOwnSnapshot,
          semanticEditIr: resolved.ir,
          ...(copied ? { copied } : {}),
          ...(interactionContext ? { interactionContext } : {}),
        });
        if (rejected) {
          restorePreWriteSnapshot(runtime, preOwnSnapshot);
          markSynced(session, address.documentId);
          return rejected;
        }
        markSynced(session, address.documentId);
        return withShown(links, result);
      } catch (cause) {
        restorePreWriteSnapshot(runtime, preOwnSnapshot);
        markSynced(session, address.documentId);
        throw cause;
      }
    }

    let syncedMutation = await submitPreparedMutation(
      {
        docId: address.documentId,
        commandName: command.command,
        runtime,
        links,
        updates: [
          {
            update: ownUpdate,
            meta,
            mutation: {
              threadId: session.threadId,
              turnId,
              ...(actor.kind === "agent" ? { authoringResponseId: actor.responseId } : {}),
              actorKind: actor.kind,
              ...(actor.kind === "human" ? { userId: actor.userId } : {}),
              ...(actor.kind === "system" ? { systemOrigin: actor.origin } : {}),
              ...(actor.kind === "agent" ? { semanticEditIr: resolved.ir } : {}),
              writeId: writeIdentity.durableId,
              wId: writeIdentity.ordinal,
              ...mutationMode(interactionContext),
            },
          },
        ],
        liveOrigin: mutationUpdateOrigin(actor),
        actor,
        before,
        touchedHashes: new Set(applied.changedBlocks),
        deletedHashes: new Set(applied.deletedBlocks),
        ...(turnId ? { turnId } : {}),
        preOwnSnapshot,
        ...(interactionContext ? { interactionContext } : {}),
      },
      session,
    );
    if (!syncedMutation.ok) {
      if (syncedMutation.journalCommitKind !== "durable") {
        return syncedMutation.response;
      }
      const awarenessDegraded = syncedMutation.awarenessDegraded;
      syncedMutation = {
        ok: true,
        journalCommitKind: "durable",
        revision: null,
        ...(awarenessDegraded ? { awarenessDegraded: true } : {}),
        summary: mutationCommit.summarizeMutationEcho({
          runtime,
          links,
          before,
          touchedHashes: new Set(applied.changedBlocks),
          deletedHashes: new Set(applied.deletedBlocks),
        }),
      };
    }

    runtimeStore.attachRuntime(session, address.documentId, runtime);
    return withShown(
      links,
      formatApplySuccess({
        ...emptiedDocument(runtime, links.codec),
        phase: "committed",
        revision: syncedMutation.revision,
        writeId: writeIdentity.handle,
        echo: syncedMutation.summary.echo,
        concurrentEdits: syncedMutation.summary.concurrentEdits,
        deletedBlocks: applied.deletedBlocks,
        ...(syncedMutation.lateSweep ? { lateSweep: syncedMutation.lateSweep } : {}),
        ...(syncedMutation.awarenessDegraded ? { awarenessDegraded: true } : {}),
        ...copiedEcho(),
      }),
    );
  }

  async function submitPreparedMutation(
    input: PreparedMutation & { runtime: RuntimeDocumentState },
    session: ActorSession,
  ) {
    let result: Awaited<ReturnType<MutationCommit["submitMutation"]>>;
    try {
      result = await mutationCommit.submitMutation(input);
    } catch (cause) {
      if (cause instanceof AcceptedMutationSubmissionError) {
        result = {
          ok: false,
          response: status("internal_error", "Retry — transient edit system failure."),
          journalCommitKind: cause.journalCommitKind,
        };
      } else {
        restorePreWriteSnapshot(input.runtime, input.preOwnSnapshot);
        markSynced(session, input.docId);
        throw cause;
      }
    }
    if (result.ok) return result;
    if (result.journalCommitKind !== "durable") {
      await runtimeStore.evictRuntime(session, input.docId);
      return result;
    }
    await runtimeStore.recoverCommittedResponseProjection([
      {
        docId: input.docId,
        session,
        runtime: input.runtime,
        commandName: input.commandName,
      },
    ]);
    return { ...result, awarenessDegraded: true };
  }

  /** Attach the links the result's rendered blocks showed, spelled with the command's binding. */
  function withShown(links: BoundLinks, result: InternalWriteResult) {
    return { ...result, ...shownEvidence(renderedItems(result.model), links) };
  }

  /** Host-only showing evidence for this document; none for utility, seed and import writes. */
  async function shownLinksFor(documentId: string, context: WriteContext) {
    return (await context.shownLinks?.(documentId)) ?? [];
  }

  function linkAssigner(
    documentId: string,
    scope: Parameters<typeof createWriteLinkAssigner>[0]["scope"],
    shown: Parameters<typeof createWriteLinkAssigner>[0]["shown"],
  ): WriteLinkAssigner {
    return createWriteLinkAssigner({
      scope,
      holderDocumentId: documentId,
      shown,
      ...(options.onLinkSpliceFallback
        ? {
            onSpliceFallback: (reason) => options.onLinkSpliceFallback?.({ documentId, reason }),
          }
        : {}),
    });
  }

  /**
   * Ahead refs the write minted are registered before anything is applied or
   * locked (§6.1); a failure fails the write, and the refs were never published.
   * Registration may settle one at once, and the echo spells them all, so the
   * scope loads them next.
   */
  async function registerMinted(
    assigner: WriteLinkAssigner,
    documentId: string,
    context: WriteContext,
  ): Promise<void> {
    if (assigner.minted.length === 0) return;
    await options.links.registerAhead(assigner.minted);
    await options.links.prepare({
      documentId,
      docs: [],
      refs: assigner.minted.map((mint) => mint.ref),
      addresses: assigner.minted.map((mint) => mint.address),
      context,
    });
  }

  function validateResolvedIr(
    ir: import("../semantic-edit-ir.js").SemanticEditIRV1,
    documentId: string,
    doc: Y.Doc,
  ): void {
    validateSemanticEditIRV1(ir, {
      expectedDocumentId: documentId,
      expectedInputRevision: documentRevision({ model: options.model, doc: toDocHandle(doc) }),
    });
  }

  async function nextWriteIdentity(
    docId: string,
    session: ActorSession,
    context: WriteContext,
    commandToolUseId?: string,
  ): Promise<{ durableId: string; ordinal: number; handle: string }> {
    const ordinal = await reversalStore.reserveWriteOrdinal(
      docId,
      session.threadId,
      context.responseId ?? context.turnId,
    );
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

  function writeCertifiedProvenance(
    runtime: { doc: Y.Doc },
    ir: SemanticEditIRV1,
    beforeStateVector: Uint8Array,
    preWriteSnapshot: Uint8Array,
  ): void {
    if (!options.semanticProvenance) return;
    try {
      options.semanticProvenance.writeCertifiedFacts(
        toDocHandle(runtime.doc),
        ir,
        beforeStateVector,
      );
    } catch (error) {
      restorePreWriteSnapshot(runtime, preWriteSnapshot);
      throw error;
    }
  }
}

const MISSING_COPIED_NODES_MESSAGE = "This deployment can't copy: the source blocks are missing.";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function restorePreWriteSnapshot(runtime: { doc: Y.Doc }, snapshot: Uint8Array): void {
  const restored = new Y.Doc({ gc: false });
  Y.applyUpdate(restored, snapshot, { type: "system" });
  runtime.doc = restored;
}

function documentBlocksDetail(details: Record<string, unknown> | undefined): number | undefined {
  return typeof details?.documentBlocks === "number" ? details.documentBlocks : undefined;
}
