// Mutating and query write command handlers.
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { snapshotBlocks } from "../apply/echo.js";
import { resolveOverwrite } from "../apply/overwrite.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import { createPlanningView, planningSnapshot } from "../frontier.js";
import { type BlockRef, toDocHandle } from "../handles.js";
import { createWriteLinkAssigner, type WriteLinkAssigner } from "../links/assign-refs.js";
import { getTopLevelXmlBlocks } from "../model/block-hash.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import type { DocumentAccess } from "../ports/document-coordinator.js";
import { editHandle } from "../ports/update-journal.js";
import { documentRevision, planWrite, type ResolveWriteResult } from "../resolver/resolve.js";
import { type SemanticEditIRV1, validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import { copySummary } from "./copy-receipt.js";
import type { DocumentRenderer, ParseForCommandResult } from "./document-renderer.js";
import { mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import { type ListingSource, recordObservation } from "./observation.js";
import { renderReceipt } from "./receipt.js";
import type { ResponseCommitter, RoomCallInput, RoomCopy } from "./response-committer.js";
import { formatApplySuccess, formatUnchangedSuccess, status } from "./response-format.js";
import type { MutationActor, ReadCommand, WriteCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { errorResponse, mutationMeta, parseFileAddress, readSuccess } from "./write-helpers.js";
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
    | "coordinator"
    | "semanticProvenance"
    | "links"
    | "onLinkSpliceFallback"
    | "onObservationFailed"
  >;
  autoTurnCounter: { value: number };
  autoTurnIdNonce: string;
  renderer: DocumentRenderer;
  journal: CreateWriteToolOptions["journal"];
  responseCommitter: ResponseCommitter;
}) {
  const { options, autoTurnCounter, autoTurnIdNonce, renderer, journal } = deps;
  const { responseCommitter } = deps;

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
    ) => Promise<InternalWriteResult>,
  ) {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    return handler(command, session, context);
  }

  /** The call's room copy, disposed when `use` settles; a door that can't read answers its result. */
  async function withRoom(
    input: Omit<RoomCallInput, "threadId" | "interactionContext" | "responseId" | "workDraftId"> & {
      session: ActorSession;
      context: WriteContext;
    },
    use: (room: RoomCopy) => Promise<InternalWriteResult>,
  ): Promise<InternalWriteResult> {
    const { session, context, ...call } = input;
    const room = await responseCommitter.openRoom({
      ...call,
      responseId: context.responseIdentity?.editScopeId,
      threadId: session.threadId,
      interactionContext: context.interactionContext,
      ...(context.workDraftId ? { workDraftId: context.workDraftId } : {}),
    });
    if (isInternalWriteResult(room)) return room;
    try {
      return await use(room);
    } finally {
      room.dispose();
    }
  }

  async function read(
    command: ReadCommand,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command);
    if (!address.ok) return status("invalid_write", address.message);
    return withRoom(
      { docId: address.documentId, commandName: "read", session, context },
      async (room) => {
        const links = await openCommandLinks(options, {
          documentId: address.documentId,
          docs: [room.doc],
          context,
        });
        const selection = renderer.selectReadBlocks(toDocHandle(room.doc), command, address);
        if (!selection.ok)
          return errorResponse(
            selection.code,
            selection.message,
            address.filePath,
            selection.documentBlocks,
          );
        return withEvidence(links, room, address.documentId, context, {
          ...readSuccess(
            renderer.renderRead(
              toDocHandle(room.doc),
              links.codec,
              selection.blocks,
              command.format === "outline" ? "outline" : "full",
            ),
          ),
          revision: options.links.revision(room.doc, links.scope),
          ...(context.includeNodes ? { nodes: selectedNodes(room.doc, selection.blocks) } : {}),
        });
      },
    );
  }

  /**
   * `use` with the doc a write plans on: the model's view (the room copy at the planning
   * frontier, then the reply's own surviving updates), or the current room when no usable
   * frontier exists. A document this reply created plans from the empty snapshot instead,
   * since the model knows it began empty. Utility, seed and import writes carry no frontiers
   * and plan on the room copy.
   */
  async function withPlanDoc(
    room: RoomCopy,
    docId: string,
    context: WriteContext,
    actor: MutationActor,
    use: (planDoc: Y.Doc) => Promise<InternalWriteResult>,
  ): Promise<InternalWriteResult> {
    const lookups = context.frontiers;
    const reply = Boolean(context.responseIdentity) && actor.kind === "agent";
    if (!lookups?.planning) {
      // Lookups without planning lost it: the write would plan on text the model never saw.
      if (lookups && reply)
        throw new Error(`A reply's write to ${docId} carries no planning frontier`);
      return use(room.doc);
    }
    const frontier = room.room ? await lookups.planning(room.room) : null;
    const usable = room.room ? planningSnapshot(room.doc, room.room, frontier) : null;
    const created = !usable && Boolean(lookups.reply?.created(docId));
    const snapshot = usable ?? (created ? Y.emptySnapshot : null);
    const view =
      snapshot &&
      createPlanningView(room.doc, snapshot, [
        ...(lookups.reply?.updates(docId) ?? []),
        ...responseCommitter.stagedUpdates(context.responseIdentity?.editScopeId, docId),
      ]);
    try {
      return await use(view ?? room.doc);
    } finally {
      view?.destroy();
    }
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
    const createdByThisReply = responseStagedCreate && context.createdDocument === true;
    const alreadyExists = status(
      "invalid_write",
      `File already exists: ${address.filePath}. Read it, then edit it; use overwrite=true only to replace all of its content.`,
    );
    return withRoom(
      {
        docId: address.documentId,
        commandName: command.command,
        session,
        context,
      },
      async (room) => {
        const responseId = context.responseIdentity?.editScopeId;
        // The host already materialized this create; its first write owns the empty copy.
        const overwriting =
          command.overwrite === true ||
          (createdByThisReply &&
            !(responseId && responseCommitter.hasScopeCut(responseId, address.documentId)));
        const existing = options.model.getBlocks(toDocHandle(room.doc)).length > 0;
        if (existing && !overwriting) return alreadyExists;
        // Creating a document or initializing an empty one plans on the room copy, exempt;
        // replacing a non-empty one plans on the model's view of it.
        const plan = (planDoc: Y.Doc) =>
          createOn(planDoc, room, {
            command,
            session,
            context,
            address,
            actor,
            parsed,
            content,
            given,
            copiedNodes,
            boundNodes,
            overwriting,
            alreadyExists,
          });
        if (existing && hasText(room.doc))
          return withPlanDoc(room, address.documentId, context, actor, plan);
        const created = await plan(room.doc);
        // The document began empty for the model: its later writes in this reply plan from that.
        if (created.status === "success") context.frontiers?.reply?.noteCreated(address.documentId);
        return created;
      },
    );
  }

  async function createOn(
    planDoc: Y.Doc,
    room: RoomCopy,
    input: {
      command: Extract<WriteCommand, { command: "create" | "copy" }>;
      session: ActorSession;
      context: WriteContext;
      address: Extract<ReturnType<typeof parseFileAddress>, { ok: true }>;
      actor: MutationActor;
      parsed: Extract<ParseForCommandResult, { ok: true }>;
      content: string;
      given: readonly Block[] | undefined;
      copiedNodes: readonly Block[] | undefined;
      boundNodes: readonly Block[] | undefined;
      overwriting: boolean;
      alreadyExists: InternalWriteResult;
    },
  ): Promise<InternalWriteResult> {
    const { command, session, context, address, actor, parsed, content, given } = input;
    const { copiedNodes, boundNodes, overwriting, alreadyExists } = input;
    const shown = given ? [] : await shownLinksFor(address.documentId, context);
    const links = await openCommandLinks(options, {
      documentId: address.documentId,
      docs: planDocs(planDoc, room),
      ...(given ? { stored: given } : { written: parsed.parsed.blocks }),
      shown,
      context,
    });
    const assigner = linkAssigner(address.documentId, links.scope, shown, context.uploadsChat);
    const existingBlocks = options.model.getBlocks(toDocHandle(planDoc));
    if (existingBlocks.length > 0 && !overwriting) return alreadyExists;
    let overwrite: Extract<ResolveWriteResult, { ok: true }> | undefined;
    if (overwriting && existingBlocks.length > 0) {
      const resolved = resolveOverwrite(
        {
          doc: toDocHandle(planDoc),
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
    return finishPreparedEdit({
      command,
      session,
      context,
      room,
      planDoc,
      assigner,
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
    const from = command.command === "remove" ? undefined : command.from;
    const copiedNodes = from ? context.copiedNodes : undefined;
    if (from && !copiedNodes) return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    if (copiedNodes?.length === 0) {
      return status("invalid_write", `from selected no blocks in ${from?.path}.`);
    }
    const { from: _from, ...selectors } = command as typeof command & { from?: unknown };
    const actor = mutationActor(session, address.documentId, context);
    return withRoom(
      { docId: address.documentId, commandName: command.command, session, context },
      (room) =>
        withPlanDoc(room, address.documentId, context, actor, async (planDoc) => {
          const shown = copiedNodes ? [] : await shownLinksFor(address.documentId, context);
          const links = await openCommandLinks(options, {
            documentId: address.documentId,
            docs: planDocs(planDoc, room),
            ...(copiedNodes ? { stored: copiedNodes } : {}),
            shown,
            context,
          });
          // Planning fixes scope, matches and a find's reconstructed groups; what
          // ref assignment will see is only known then, so it loads before assignment runs.
          const plan = planWrite(
            { doc: toDocHandle(planDoc), model: options.model, codec: links.codec },
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
          const assigner = linkAssigner(
            address.documentId,
            links.scope,
            shown,
            context.uploadsChat,
          );
          const resolved = plan.ok ? plan.assign(assigner) : plan;
          if (!resolved.ok) {
            return errorResponse(
              resolved.error.code,
              resolved.error.message,
              address.filePath,
              documentBlocksDetail(resolved.error.details),
            );
          }
          validateResolvedIr(resolved.ir, address.documentId, planDoc);
          if (resolved.edits.length === 0) return formatUnchangedSuccess();
          return finishPreparedEdit({
            command,
            session,
            context,
            room,
            planDoc,
            assigner,
            links,
            actor,
            docId: address.documentId,
            filePath: address.filePath,
            plan: { edits: resolved.edits, ir: resolved.ir },
            ...(from && copiedNodes ? { copy: { from: from.path, edges: true } } : {}),
          });
        }),
    );
  }

  interface PreparedEdit {
    command: WriteCommand;
    session: ActorSession;
    context: WriteContext;
    /** The call's room copy: the echo and the recorded frontier render from it. */
    room: RoomCopy;
    /** What the write plans and applies on: the model's view, or the room copy itself. */
    planDoc: Y.Doc;
    /** Refs the write minted, registered after planning succeeds. */
    assigner: WriteLinkAssigner;
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
    const { command, session, context, room, planDoc, links, actor, docId, filePath, plan } = edit;
    if (planDoc !== room.doc && "edits" in plan && hasMissingTarget(plan.edits, room.doc)) {
      return status("not_found", "The selected block no longer exists.");
    }
    await registerMinted(edit.assigner, docId, context);
    const identity = await nextWriteIdentity(docId, session, context, command.tool_use_id);
    const editScopeId = context.responseIdentity?.editScopeId;
    const staged = Boolean(editScopeId) && actor.kind === "agent";
    // A save's first entry keeps the room's cut: reconcile reads what retired since.
    const cut =
      staged && editScopeId && responseCommitter.hasScopeCut(editScopeId, docId)
        ? undefined
        : { snapshot: Y.encodeSnapshotV2(Y.snapshot(room.doc)) };
    const preOwnSnapshot = Y.encodeStateAsUpdate(planDoc);
    // The echo compares with what the model planned on, as the settled receipt does: a block
    // the writer changed since the view shows in full beside the write.
    const planned = snapshotBlocks(toDocHandle(planDoc), options.model, links.codec);
    const beforeVector = Y.encodeStateVector(planDoc);
    // A view lacks the room's newer clients; a fresh segment client must avoid them too.
    const roomClients =
      planDoc === room.doc
        ? undefined
        : new Set(Y.decodeStateVector(Y.encodeStateVector(room.doc)).keys());
    const origin = "agent-write";
    const semanticEditIr = "ir" in plan ? plan.ir : undefined;
    const captured = captureWriteUpdate<import("../apply/types.js").ApplyResult>(
      planDoc,
      roomClients,
      (beforeSegment) => {
        if ("edits" in plan)
          return applyEdits(
            toDocHandle(planDoc),
            options.model,
            plan.edits,
            origin,
            beforeSegment,
            certifySegment(planDoc, plan.ir, beforeVector),
          );
        beforeSegment?.();
        let insertedBlocks: string[] = [];
        planDoc.transact(() => {
          insertedBlocks = options.model
            .insertBlocks(toDocHandle(planDoc), null, { blocks: [...plan.blocks] })
            .map((block) => options.model.getBlockId(block));
        }, origin);
        return { ok: true, changedBlocks: [], deletedBlocks: [], insertedBlocks };
      },
    );
    const { result: applied, update, parts } = captured;
    if (!applied.ok) return errorResponse(applied.error.code, applied.error.message, filePath);
    const touchedHashes = new Set(applied.changedBlocks),
      deletedHashes = new Set(applied.deletedBlocks);
    const blockIds = options.model.getDocumentBlockIds(toDocHandle(planDoc));
    const touchedBlocks = options.model
      .getBlocks(toDocHandle(planDoc))
      .filter((_, index) => touchedHashes.has(blockIds[index]))
      .map((block) => options.model.getCanonicalBlockIdentity(block));
    const deletedBlocks = planned.filter((block) => deletedHashes.has(block.hash));
    // The echo shows the write merged into the room, the writer's surviving words included.
    if (planDoc !== room.doc) Y.applyUpdate(room.doc, update);
    const copied = edit.copy
      ? copySummary(edit.copy.from, applied.insertedBlocks, edit.copy)
      : undefined;
    const interactionContext = context.interactionContext;
    const meta = mutationMeta(actor);
    const turnId = actor.kind === "agent" ? actor.turnId : null;
    let phase: "staged" | "committed",
      revision: string | null = null;
    let lateSweep: import("./commit-detection.js").DestructiveSweepReport | undefined;
    let awarenessDegraded = false;
    if (staged && editScopeId && actor.kind === "agent") {
      const rejected = responseCommitter.stageUpdate({
        responseId: editScopeId,
        docId,
        session,
        room,
        cut,
        commandName: command.command,
        documentLabel: command.file,
        description: stagedWriteDescription(command),
        update,
        editParts: parts,
        meta,
        actor,
        turnId: actor.turnId,
        writeId: identity.handle,
        writeOrdinal: identity.ordinal,
        durableWriteId: identity.durableId,
        toolCallId: identity.toolCallId,
        createdDocumentBeforeCommit: edit.creation?.createdDocument ?? false,
        touchedBlocks,
        deletedBlocks,
        preOwnSnapshot,
        semanticEditIr,
        copied,
        interactionContext,
        ...(context.frontiers?.reply ? { reply: context.frontiers.reply } : {}),
      });
      if (rejected) return rejected;
      phase = "staged";
    } else {
      if (!cut) throw new Error(`A write outside a reply on ${docId} took no room cut`);
      const saved = await responseCommitter.saveNow({
        docId,
        cut,
        links,
        entry: {
          docId,
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
        actor,
        preOwnSnapshot,
        refuseUnlessEmpty: edit.creation?.refuseUnlessEmpty,
        interactionContext,
      });
      if (isInternalWriteResult(saved)) return saved;
      // The echo and frontier show the room as the save left it, as a reply's receipt does.
      Y.applyUpdate(room.doc, saved.afterState);
      context.frontiers?.reply?.append(docId, [update]);
      revision = saved.revision;
      lateSweep = saved.lateSweep;
      awarenessDegraded = Boolean(saved.awarenessDegraded);
      phase = "committed";
    }
    const outcome = {
      phase,
      revision,
      writeId: identity.handle,
      ...(phase === "staged" ? { settlementId: identity.durableId } : {}),
      lateSweep,
      awarenessDegraded,
    };
    // A staged echo records nothing: the reply's save replaces it before the model's next request.
    const recorded = phase === "staged" ? { ...context, frontiers: undefined } : context;
    const ownRemoved = new Set(deletedBlocks.map((block) => `${block.clientID}:${block.clock}`));
    try {
      return await withEvidence(
        links,
        room,
        docId,
        recorded,
        renderReceipt(
          {
            commandName: command.command,
            writeId: identity.handle,
            durableWriteId: identity.durableId,
            touchedBlocks,
            deletedBlocks,
            copied,
          },
          planned,
          snapshotBlocks(toDocHandle(room.doc), options.model, links.codec),
          outcome,
        ),
        { ownRemoved, written: [update] },
      );
    } catch {
      return withEvidence(
        links,
        room,
        docId,
        recorded,
        formatApplySuccess({ ...outcome, echo: [], awarenessDegraded: true }),
        { ownRemoved },
      );
    }
  }

  /**
   * Attach what the rendered result showed: its links, spelled with the command's links, and,
   * when the host passed lookups, the listing of what changed that it doesn't show and its
   * observation frontier in the room the copy was read from.
   */
  function withEvidence(
    links: CommandLinks,
    room: RoomCopy,
    documentId: string,
    context: WriteContext,
    result: InternalWriteResult,
    own?: Pick<ListingSource, "ownRemoved" | "written">,
  ): Promise<InternalWriteResult> {
    return recordObservation(
      result,
      {
        doc: room.doc,
        model: options.model,
        links,
        ...own,
        ...(context.turnId ? { ownActorTurnIds: new Set([context.turnId]) } : {}),
        ...(options.coordinator.concurrentUpdatesSince
          ? {
              loadConcurrent: (baselineDoc: Y.Doc) =>
                options.coordinator.concurrentUpdatesSince?.({
                  docId: documentId,
                  doc: room.doc,
                  baselineDoc,
                  sinceStateVector: Y.encodeStateVector(baselineDoc),
                  access: observationAccess(context),
                }) ?? Promise.resolve([]),
            }
          : {}),
      },
      room.room,
      context.frontiers?.recording,
      documentId,
      options.onObservationFailed,
    );
  }

  function hasMissingTarget(edits: readonly ResolvedEdit[], current: Y.Doc): boolean {
    const live = new Set(
      options.model.getBlocks(toDocHandle(current)).map((block) => {
        const id = options.model.getCanonicalBlockIdentity(block);
        return `${id.clientID}:${id.clock}`;
      }),
    );
    return edits.some((edit) => {
      const target = edit.kind === "insert" ? edit.after : edit.block;
      if (!target) return false;
      const id = options.model.getCanonicalBlockIdentity(target);
      return !live.has(`${id.clientID}:${id.clock}`);
    });
  }

  function observationAccess(context: WriteContext): DocumentAccess | undefined {
    if (context.interactionContext?.mode === "threadPeer" && context.interactionContext.peerDraftId)
      return { pinnedDraftId: context.interactionContext.peerDraftId };
    return context.workDraftId ? { workDraftId: context.workDraftId } : undefined;
  }

  /** Host-only showing evidence for this document; none for utility, seed and import writes. */
  async function shownLinksFor(documentId: string, context: WriteContext) {
    return (await context.shownLinks?.(documentId)) ?? [];
  }

  function linkAssigner(
    documentId: string,
    scope: Parameters<typeof createWriteLinkAssigner>[0]["scope"],
    shown: Parameters<typeof createWriteLinkAssigner>[0]["shown"],
    uploadsChat: string | undefined,
  ): WriteLinkAssigner {
    return createWriteLinkAssigner({
      scope,
      shown,
      ...(uploadsChat ? { uploadsChat } : {}),
      ...(options.onLinkSpliceFallback
        ? {
            onSpliceFallback: (reason) => options.onLinkSpliceFallback?.({ documentId, reason }),
          }
        : {}),
    });
  }

  /**
   * Ahead refs the write minted are registered before anything is applied or
   * locked (§6.1); a failure fails the write, and the refs were never registered.
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
      handle: editHandle(ordinal),
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
    doc: Y.Doc,
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
        toDocHandle(doc),
        { ...ir, intent: { ...intent, edits } },
        beforeStateVector,
      );
    };
  }
}

const MISSING_COPIED_NODES_MESSAGE = "This deployment can't copy: the source blocks are missing.";

/**
 * Whether the document holds anything beyond the one blank block an empty document keeps:
 * initializing an empty document isn't checked against the model's view.
 */
function hasText(doc: Y.Doc): boolean {
  return getTopLevelXmlBlocks(doc).some((block) =>
    block.toArray().some((child) => !(child instanceof Y.XmlText) || child.length > 0),
  );
}

/** The docs a write's links spell: the plan doc and, when it is a view, the room copy. */
function planDocs(planDoc: Y.Doc, room: RoomCopy): Y.Doc[] {
  return planDoc === room.doc ? [planDoc] : [planDoc, room.doc];
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
  excludedClients: ReadonlySet<number> | undefined,
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
    doc.clientID = allocateDocumentClient(doc, excludedClients);
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
