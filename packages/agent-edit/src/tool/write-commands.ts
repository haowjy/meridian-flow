// Mutating and query write command handlers.

import * as Y from "yjs";
import { resolveOverwrite } from "../apply/overwrite.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import { createPlanningView, planningSnapshot } from "../frontier.js";
import { type BlockRef, toDocHandle, unwrapBlock } from "../handles.js";
import { createWriteLinkAssigner, type WriteLinkAssigner } from "../links/assign-refs.js";
import { getTopLevelXmlBlocks } from "../model/block-hash.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { documentRevision, planWrite, type ResolveWriteResult } from "../resolver/resolve.js";
import { validateSemanticEditIRV1 } from "../semantic-edit-ir.js";
import { openCommandLinks } from "./command-links.js";
import type { DocumentRenderer, ParseForCommandResult } from "./document-renderer.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import type { ResponseCommitter, RoomCallInput, RoomCopy } from "./response-committer.js";
import { formatUnchangedSuccess, status } from "./response-format.js";
import { readCall } from "./result-text.js";
import type { MutationActor, ReadCommand, WriteCommand, WriteContext } from "./types.js";
import { createWriteAcceptance, type Planned } from "./write-acceptance.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { errorResponse, parseFileAddress, readSuccess } from "./write-helpers.js";
import { scopedToolUseId } from "./write-idempotency.js";

/** Name the rejected logical write, not its model-facing ordinal. */
function _stagedWriteDescription(command: WriteCommand): string {
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
  const { options, autoTurnCounter, autoTurnIdNonce, renderer } = deps;
  const { responseCommitter } = deps;
  const { finishPreparedEdit, withEvidence } = createWriteAcceptance(deps);

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
   * `use` with the doc a write plans on and what its region check reads: the model's view (the
   * room copy at the planning frontier, then the reply's own surviving updates) and that
   * frontier; the room copy and null when the room has no valid frontier or the view is
   * incomplete. A document this reply created plans from the empty snapshot instead, since the
   * model knows it began empty; the region check still runs (lead ruling). A host that keeps no
   * frontiers passes no lookups at all: its writes, and any write that is no model reply's
   * (utility, seed, import), plan on the room copy, exempt.
   */
  async function withPlanDoc(
    room: RoomCopy,
    docId: string,
    context: WriteContext,
    actor: MutationActor,
    use: (planDoc: Y.Doc, planned: Planned) => Promise<InternalWriteResult>,
  ): Promise<InternalWriteResult> {
    const lookups = context.frontiers;
    const reply = Boolean(context.responseIdentity) && actor.kind === "agent";
    if (!lookups?.planning) {
      // Lookups without planning lost it: the write would plan on text the model never saw.
      if (lookups && reply)
        throw new Error(`A reply's write to ${docId} carries no planning frontier`);
      return use(room.doc, "exempt");
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
      return await use(view ?? room.doc, view ? (usable && frontier) || { unshown: [] } : null);
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
        const plan = (planDoc: Y.Doc, planned: Planned) =>
          createOn(planDoc, room, planned, {
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
        const created = await plan(room.doc, "exempt");
        // The document began empty for the model: its later writes in this reply plan from that.
        if (created.status === "success") context.frontiers?.reply?.noteCreated(address.documentId);
        return created;
      },
    );
  }

  async function createOn(
    planDoc: Y.Doc,
    room: RoomCopy,
    planned: Planned,
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
      planned,
      assigner,
      links,
      actor,
      docId: address.documentId,
      filePath: address.filePath,
      plan: overwrite
        ? { groups: [{ edits: overwrite.edits, targets: "all" }], ir: overwrite.ir }
        : { blocks: written.blocks },
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
        withPlanDoc(room, address.documentId, context, actor, async (planDoc, planned) => {
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
            // With no frontier here, a target the room can't place was never shown in this room.
            if (planned === null && LOCATE_FAILURES.has(resolved.error.code))
              return status(
                "region_changed",
                `Not applied: you haven't seen the current text of this document. Read it with ${readCall(address.filePath)}, then write again.`,
              );
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
            planned,
            assigner,
            links,
            actor,
            docId: address.documentId,
            filePath: address.filePath,
            plan: {
              groups: [{ edits: resolved.edits, targets: targetIndexes(planDoc, resolved.edits) }],
              ir: resolved.ir,
            },
            ...(from && copiedNodes ? { copy: { from: from.path, edges: true } } : {}),
          });
        }),
    );
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
}

const MISSING_COPIED_NODES_MESSAGE = "This deployment can't copy: the source blocks are missing.";

/** Resolution failures that mean the room couldn't place a target, not a malformed write. */
const LOCATE_FAILURES = new Set<string>(["not_found", "ambiguous_match"]);

/**
 * Whether the document holds anything beyond the one blank block an empty document keeps:
 * initializing an empty document isn't checked against the model's view.
 */
function hasText(doc: Y.Doc): boolean {
  return getTopLevelXmlBlocks(doc).some((block) =>
    block.toArray().some((child) => !(child instanceof Y.XmlText) || child.length > 0),
  );
}

/** Each edit's target block on `doc`: the edited block, or an insert's anchor (-1 at the start). */
function targetIndexes(doc: Y.Doc, edits: readonly ResolvedEdit[]): number[] {
  const blocks = getTopLevelXmlBlocks(doc);
  const index = new Map(blocks.map((block, position) => [block as unknown, position]));
  return edits.flatMap((edit) => {
    const target = edit.kind === "insert" ? edit.after : edit.block;
    if (!target) return [-1];
    const position = index.get(unwrapBlock(target));
    return position === undefined ? [] : [position];
  });
}

/** The docs a write's links spell: the plan doc and, when it is a view, the room copy. */
function planDocs(planDoc: Y.Doc, room: RoomCopy): Y.Doc[] {
  return planDoc === room.doc ? [planDoc] : [planDoc, room.doc];
}

function documentBlocksDetail(details: Record<string, unknown> | undefined): number | undefined {
  return typeof details?.documentBlocks === "number" ? details.documentBlocks : undefined;
}
