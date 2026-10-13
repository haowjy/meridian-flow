// Mutating and query write command handlers.
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { snapshotBlocks } from "../apply/echo.js";
import { resolveOverwrite } from "../apply/overwrite.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import { type BlockRef, toDocHandle } from "../handles.js";
import { createWriteLinkAssigner, type WriteLinkAssigner } from "../links/assign-refs.js";
import { renderedItems, shownEvidence, withRunShownLinks } from "../links/shown.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { writeHandle } from "../ports/update-journal.js";
import { documentRevision, planWrite, type ResolveWriteResult } from "../resolver/resolve.js";
import { type SemanticEditIRV1, validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import { copySummary } from "./copy-receipt.js";
import type { DocumentRenderer, ParseForCommandResult } from "./document-renderer.js";
import { interactionContextForAttempt, mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import {
  AcceptedMutationSubmissionError,
  type MutationCommit,
  type PreparedMutation,
} from "./mutation-commit.js";
import { renderReceipt } from "./receipt.js";
import type { CommandDocumentLease, ResponseCommitter } from "./response-committer.js";
import { formatApplySuccess, formatUnchangedSuccess, status } from "./response-format.js";
import type { RuntimeStore } from "./runtime-store.js";
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

/** Name the rejected logical write, not its model-facing ordinal. */
function stagedWriteDescription(command: WriteCommand): string {
  const before = "find" in command ? JSON.stringify(command.find) : command.command;
  const after =
    "content" in command
      ? JSON.stringify(command.content)
      : command.command === "remove"
        ? '""'
        : undefined;
  return [before, after].filter(Boolean).join(" → ");
}

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
  autoTurnCounter: { value: number };
  autoTurnIdNonce: string;
  renderer: DocumentRenderer;
  journal: CreateWriteToolOptions["journal"];
  mutationCommit: MutationCommit;
  runtimeStore: RuntimeStore;
  responseCommitter: ResponseCommitter;
}) {
  const {
    options,
    autoTurnCounter,
    autoTurnIdNonce,
    renderer,
    journal,
    mutationCommit,
    runtimeStore,
    responseCommitter,
  } = deps;
  const { markSynced } = runtimeStore;

  return {
    read: (command: ReadCommand, session: ActorSession, context: WriteContext) =>
      run(command, session, context, read),
    create: (
      command: Extract<WriteCommand, { command: "create" | "copy" }>,
      session: ActorSession,
      context: WriteContext,
    ) => run(command, session, context, create),
    mutate: (
      command: Extract<WriteCommand, { command: "insert" | "replace" | "remove" }>,
      session: ActorSession,
      context: WriteContext,
    ) => run(command, session, context, mutate),
  };

  async function run<C extends ReadCommand | WriteCommand>(
    command: C,
    session: ActorSession,
    context: WriteContext,
    handler: (
      command: C,
      session: ActorSession,
      context: WriteContext,
      lease: CommandDocumentLease,
    ) => Promise<InternalWriteResult>,
  ) {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    return responseCommitter.stage(
      {
        responseId: context.responseIdentity?.editScopeId,
        docId: address.documentId,
        session,
        commandName: "command" in command ? command.command : "read",
        context,
      },
      (lease) => handler(command, session, context, lease),
    );
  }

  async function read(
    command: ReadCommand,
    session: ActorSession,
    context: WriteContext,
    runtime: CommandDocumentLease,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);

    const restored = await runtime.restore();
    if (isInternalWriteResult(restored)) return restored;
    const links = await openCommandLinks(options, {
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
    runtime: CommandDocumentLease,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    const actor = mutationActor(session, address.documentId, context);
    if (address.fragment) {
      return status("invalid_write", `${command.command} does not accept a #fragment in file.`);
    }
    const copiedNodes = command.command === "copy" ? context.copiedNodes : undefined;
    if (command.command === "copy" && !copiedNodes) {
      return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    }
    const content = command.command === "create" ? (command.content ?? "") : "";
    // A host's bound write (§6.2) arrives as nodes: never parsed or assigned again.
    const boundNodes = command.command === "create" ? context.boundNodes : undefined;
    if (!options.lifecycle) {
      return status("invalid_write", "document creation is not supported by this deployment");
    }
    if (context.responseIdentity?.editScopeId && actor.kind === "agent") {
      responseCommitter.assertCanStage({
        responseId: context.responseIdentity?.editScopeId,
        docId: address.documentId,
        session,
        turnId: context.turnId,
        writeId: scopedToolUseId(context, command.tool_use_id ?? context.tool_use_id),
      });
    }

    const given = copiedNodes ?? boundNodes;
    const parsed: ParseForCommandResult = given
      ? { ok: true, parsed: { blocks: [...given] } }
      : renderer.parseForCommand(content);
    if (!parsed.ok) return status("invalid_write", parsed.message);

    const responseStagedCreate =
      context.responseIdentity?.editScopeId !== undefined && actor.kind === "agent";
    if (responseStagedCreate && context.createdDocument === undefined) {
      return status(
        "invalid_write",
        "Staged create requires host-resolved createdDocument ownership metadata.",
      );
    }
    const deferNewDocumentCreation = responseStagedCreate && context.createdDocument === true;
    const overwriting =
      command.overwrite === true || (deferNewDocumentCreation && !runtime.hasStagedWrites);
    if (!deferNewDocumentCreation) await options.lifecycle.ensureDocument(address.documentId);
    const alreadyExists = status(
      "invalid_write",
      `File already exists: ${address.filePath}. Read it, then edit it; use overwrite=true only to replace all of its content.`,
    );
    const liveCheck = await runtime.checkEmpty(overwriting, alreadyExists);
    const missingLiveForDeferredNewDocument =
      deferNewDocumentCreation &&
      isInternalWriteResult(liveCheck) &&
      liveCheck.status === "document_not_found";
    if (isInternalWriteResult(liveCheck) && !missingLiveForDeferredNewDocument) return liveCheck;

    if (!missingLiveForDeferredNewDocument) {
      const restored = await runtime.restore();
      if (isInternalWriteResult(restored)) return restored;
    }
    if (missingLiveForDeferredNewDocument) {
      runtime.doc = options.createRuntimeDoc?.() ?? new Y.Doc({ gc: false });
    }
    const shown = given ? [] : await shownLinksFor(address.documentId, context);
    const links = await openCommandLinks(options, {
      documentId: address.documentId,
      docs: [runtime.doc],
      ...(given ? { stored: given } : { written: parsed.parsed.blocks }),
      shown,
      context,
    });
    const assigner = linkAssigner(address.documentId, links.scope, shown);
    const existingBlocks = options.model.getBlocks(toDocHandle(runtime.doc));
    if (existingBlocks.length > 0 && !overwriting) return alreadyExists;
    let overwrite: Extract<ResolveWriteResult, { ok: true }> | undefined;
    if (overwriting && existingBlocks.length > 0) {
      const resolved = resolveOverwrite(
        {
          doc: toDocHandle(runtime.doc),
          model: options.model,
          codec: links.codec,
          links: boundNodes ? "preassigned" : assigner,
        },
        address,
        copiedNodes ? { blocks: copiedNodes } : { content, parsedContent: parsed.parsed },
        given ? given.length === 0 : content.length === 0,
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
    // Copies and bound nodes carry what they name; written content into an empty document is
    // assigned fresh.
    const written =
      given || overwrite
        ? parsed.parsed
        : { blocks: assigner.assignSpan([], parsed.parsed.blocks) };
    await registerMinted(assigner, address.documentId, context);
    return finishPreparedEdit({
      command,
      session,
      context,
      runtime,
      links,
      actor,
      docId: address.documentId,
      filePath: address.filePath,
      plan: overwrite ? { edits: overwrite.edits, ir: overwrite.ir } : { blocks: written.blocks },
      creation: {
        createdDocument: context.createdDocument === true,
        ...(overwriting ? {} : { refuseUnlessEmpty: alreadyExists }),
      },
      ...(copiedNodes
        ? { copy: { from: command.command === "copy" ? command.from.path : "", edges: false } }
        : {}),
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" | "remove" }>,
    session: ActorSession,
    context: WriteContext,
    runtime: CommandDocumentLease,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    if (context.responseIdentity?.editScopeId) {
      responseCommitter.assertCanStage({
        responseId: context.responseIdentity?.editScopeId,
        docId: address.documentId,
        session,
        turnId: context.turnId,
        writeId: scopedToolUseId(context, command.tool_use_id ?? context.tool_use_id),
      });
    }
    const synced = await runtime.sync();
    if (!synced.ok) return synced.response;

    const from = command.command === "remove" ? undefined : command.from;
    const copiedNodes = from ? context.copiedNodes : undefined;
    if (from && !copiedNodes) return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    if (copiedNodes?.length === 0) {
      return status("invalid_write", `from selected no blocks in ${from?.path}.`);
    }
    const { from: _from, ...selectors } = command as typeof command & { from?: unknown };
    const shown = copiedNodes ? [] : await shownLinksFor(address.documentId, context);
    const links = await openCommandLinks(options, {
      documentId: address.documentId,
      docs: [runtime.doc],
      ...(copiedNodes ? { stored: copiedNodes } : {}),
      shown,
      context,
    });
    // Planning fixes scope, matches and a find's reconstructed groups; what
    // ref assignment will see is only known then, so it loads before assignment runs.
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
    const resolved = plan.ok ? plan.assign(assigner) : plan;
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

    return finishPreparedEdit({
      command,
      session,
      context,
      runtime,
      links,
      actor: mutationActor(session, address.documentId, context),
      docId: address.documentId,
      filePath: address.filePath,
      plan: { edits: resolved.edits, ir: resolved.ir },
      ...(from && copiedNodes ? { copy: { from: from.path, edges: true } } : {}),
    });
  }

  interface PreparedEdit {
    command: WriteCommand;
    session: ActorSession;
    context: WriteContext;
    runtime: CommandDocumentLease;
    links: CommandLinks;
    actor: MutationActor;
    docId: string;
    filePath: string;
    plan: { edits: readonly ResolvedEdit[]; ir: SemanticEditIRV1 } | { blocks: readonly Block[] };
    creation?: { createdDocument: boolean; refuseUnlessEmpty?: InternalWriteResult };
    copy?: { from: string; edges: boolean };
  }

  /** One acceptance boundary for every edit; report failures cannot enter its restoration path. */
  async function finishPreparedEdit(edit: PreparedEdit): Promise<InternalWriteResult> {
    const { command, session, context, runtime, links, actor, docId, filePath, plan } = edit;
    const identity = await nextWriteIdentity(docId, session, context, command.tool_use_id);
    const preOwnSnapshot = Y.encodeStateAsUpdate(runtime.doc);
    const before = snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec);
    const beforeVector = Y.encodeStateVector(runtime.doc);
    const origin = "agent-write";
    const semanticEditIr = "ir" in plan ? plan.ir : undefined;
    const restore = () => {
      restorePreWriteSnapshot(runtime, preOwnSnapshot);
      markSynced(session, docId);
    };
    let captured: ReturnType<typeof captureWriteUpdate<import("../apply/types.js").ApplyResult>>;
    try {
      captured = captureWriteUpdate(runtime.doc, (beforeSegment) => {
        if ("edits" in plan)
          return applyEdits(
            toDocHandle(runtime.doc),
            options.model,
            plan.edits,
            origin,
            beforeSegment,
            certifySegment(runtime, plan.ir, beforeVector),
          );
        beforeSegment?.();
        let insertedBlocks: string[] = [];
        runtime.doc.transact(() => {
          insertedBlocks = options.model
            .insertBlocks(toDocHandle(runtime.doc), null, { blocks: [...plan.blocks] })
            .map((block) => options.model.getBlockId(block));
        }, origin);
        return { ok: true, changedBlocks: [], deletedBlocks: [], insertedBlocks };
      });
    } catch (cause) {
      restore();
      throw cause;
    }
    const { result: applied, update, parts } = captured;
    if (!applied.ok) {
      restore();
      return errorResponse(applied.error.code, applied.error.message, filePath);
    }
    const touchedHashes = new Set(applied.changedBlocks),
      deletedHashes = new Set(applied.deletedBlocks);
    const copied = edit.copy
      ? copySummary(edit.copy.from, applied.insertedBlocks, edit.copy)
      : undefined;
    const interactionContext = interactionContextForAttempt(
      context.interactionContext,
      identity.durableId,
    );
    const meta = mutationMeta(actor),
      liveOrigin = mutationUpdateOrigin(actor);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    let phase: "staged" | "committed",
      revision: string | null = null;
    let concurrentEdits: import("../apply/types.js").ConcurrentEditInfo | undefined;
    let lateSweep: import("./mutation-commit.js").DestructiveSweepReport | undefined;
    let awarenessDegraded = false;
    if (context.responseIdentity?.editScopeId && actor.kind === "agent") {
      // Await attribution before staging: the lease must still be current at acceptance.
      try {
        if (interactionContext) {
          const concurrent = await mutationCommit.detectConcurrentEdits({
            docId,
            runtime,
            links,
            reportingOnly: runtime.reportingOnly,
            interactionContext,
            preOwnSnapshot,
            ownTurnId: actor.turnId,
          });
          concurrentEdits = concurrent.info;
        }
      } catch {
        awarenessDegraded = true;
      }
      try {
        const rejected = responseCommitter.stageUpdate({
          responseId: context.responseIdentity?.editScopeId,
          docId,
          session,
          runtime,
          commandName: command.command,
          documentLabel: command.file,
          description: stagedWriteDescription(command),
          update,
          editParts: parts,
          meta,
          liveOrigin,
          actor,
          turnId: actor.turnId,
          writeId: identity.handle,
          writeOrdinal: identity.ordinal,
          durableWriteId: identity.durableId,
          toolCallId: identity.toolCallId,
          ensureDocumentBeforeCommit: Boolean(edit.creation),
          createdDocumentBeforeCommit: edit.creation?.createdDocument ?? false,
          touchedHashes,
          deletedHashes,
          preOwnSnapshot,
          semanticEditIr,
          copied,
          interactionContext,
        });
        if (rejected) {
          restore();
          return rejected;
        }
      } catch (cause) {
        restore();
        throw cause;
      }
      markSynced(session, docId);
      phase = "staged";
    } else {
      const committed = await submitPreparedMutation(
        {
          docId,
          commandName: command.command,
          runtime,
          links,
          updates: [
            {
              update,
              meta,
              mutation: {
                editParts: parts,
                threadId: session.threadId,
                turnId,
                ...(actor.kind === "agent"
                  ? { authoringResponseId: actor.responseId, editScopeId: actor.editScopeId }
                  : {}),
                actorKind: actor.kind,
                ...(actor.kind === "human" ? { userId: actor.userId } : {}),
                ...(actor.kind === "system" ? { systemOrigin: actor.origin } : {}),
                writeId: identity.durableId,
                wId: identity.ordinal,
                toolCallId: identity.toolCallId,
                semanticEditIr,
                ...mutationMode(interactionContext),
              },
            },
          ],
          liveOrigin,
          actor,
          touchedHashes,
          deletedHashes,
          preOwnSnapshot,
          refuseUnlessEmpty: edit.creation?.refuseUnlessEmpty,
          ...(turnId ? { turnId } : {}),
          interactionContext,
        },
        session,
      );
      if (!committed.ok && committed.journalCommitKind !== "durable") return committed.response;
      if (committed.ok) {
        revision = committed.revision;
        concurrentEdits = committed.concurrentEdits;
        lateSweep = committed.lateSweep;
        awarenessDegraded = Boolean(committed.awarenessDegraded);
      } else awarenessDegraded = true;
      runtime.attach();
      phase = "committed";
    }
    const outcome = {
      phase,
      revision,
      writeId: identity.handle,
      ...(phase === "staged" ? { settlementId: identity.durableId } : {}),
      concurrentEdits,
      lateSweep,
      awarenessDegraded,
    };
    try {
      return withShown(
        links,
        renderReceipt(
          {
            commandName: command.command,
            writeId: identity.handle,
            durableWriteId: identity.durableId,
            touchedHashes,
            deletedHashes,
            copied,
          },
          before,
          snapshotBlocks(toDocHandle(runtime.doc), options.model, links.codec),
          { ...outcome, concurrentEdits: withRunShownLinks(concurrentEdits, links) },
        ),
      );
    } catch {
      return formatApplySuccess({ ...outcome, echo: [], awarenessDegraded: true });
    }
  }

  async function submitPreparedMutation(
    input: PreparedMutation & { runtime: CommandDocumentLease },
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
    await input.runtime.recover();
    return { ...result, awarenessDegraded: true };
  }

  /** Attach the links the result's rendered blocks showed, spelled with the command's links. */
  function withShown(links: CommandLinks, result: InternalWriteResult) {
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
  ): Promise<{ durableId: string; ordinal: number; handle: string; toolCallId?: string }> {
    const ordinal = await journal.reserveWriteOrdinal(docId, session.threadId);
    const durableId =
      scopedToolUseId(context, commandToolUseId ?? context.tool_use_id) ??
      globalThis.crypto?.randomUUID?.() ??
      `${session.threadId}:${docId}:write-${ordinal}`;
    const toolCallId = commandToolUseId ?? context.tool_use_id;
    return {
      durableId,
      ordinal,
      handle: writeHandle(ordinal),
      ...(toolCallId ? { toolCallId } : {}),
    };
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
      responseId: context.responseIdentity?.providerResponseId,
      editScopeId: context.responseIdentity?.editScopeId,
    };
  }

  /** Certify inside the segment's prose transaction, before capture rotates its fresh client. */
  function certifySegment(
    runtime: { doc: Y.Doc },
    ir: SemanticEditIRV1,
    beforeStateVector: Uint8Array,
  ): (segment: readonly ResolvedEdit[]) => void {
    return (segment) => {
      const intent = ir.intent;
      if (intent.kind === "fullScopeFreshReplacement") return;
      const edits = intent.edits.filter(({ edit }) =>
        segment.some(
          (part) =>
            part === edit ||
            (part.kind === "textRanges" &&
              edit.kind === "textRanges" &&
              part.block === edit.block &&
              part.replacements.some((replacement) => edit.replacements.includes(replacement))),
        ),
      );
      options.semanticProvenance?.writeCertifiedFacts(
        toDocHandle(runtime.doc),
        { ...ir, intent: { ...intent, edits } },
        beforeStateVector,
      );
    };
  }
}

const MISSING_COPIED_NODES_MESSAGE = "This deployment can't copy: the source blocks are missing.";

function restorePreWriteSnapshot(runtime: { doc: Y.Doc }, snapshot: Uint8Array): void {
  const restored = new Y.Doc({ gc: false });
  Y.applyUpdate(restored, snapshot, { type: "system" });
  const previous = runtime.doc;
  runtime.doc = restored;
  previous.destroy();
}

function documentBlocksDetail(details: Record<string, unknown> | undefined): number | undefined {
  return typeof details?.documentBlocks === "number" ? details.documentBlocks : undefined;
}

/**
 * Capture the synchronous content and certification transactions, not a state-vector
 * diff: that diff includes every old tombstone and couples otherwise independent writes.
 */
function captureWriteUpdate<T>(
  doc: Y.Doc,
  write: (beforeSegment?: () => void) => T,
): { result: T; update: Uint8Array; parts: Uint8Array[] } {
  const updates: Uint8Array[] = [];
  const segments: Uint8Array[] = [];
  const flush = () => {
    if (updates.length) {
      segments.push(Y.mergeUpdates(updates.splice(0)));
    }
  };
  const beforeSegment = () => {
    flush();
    doc.clientID = allocateDocumentClient(doc);
  };
  const collect = (update: Uint8Array) => updates.push(update);
  doc.on("update", collect);
  try {
    const result = write(beforeSegment);
    flush();
    const update = Y.mergeUpdates(segments);
    return { result, update, parts: segments };
  } finally {
    doc.off("update", collect);
  }
}
