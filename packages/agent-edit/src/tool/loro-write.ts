// The model's `read` and `write` on Loro (design §5): read the room fresh, plan on a view at the
// frontiers the model read, lower with `applyOps`, save the view's update as one batch with its
// record, and record what the result showed.
import { loroRoomName } from "@meridian/contracts/protocol";
import {
  decodeEnvelope,
  encodeEnvelope,
  encodeRoomVersion,
  freshServerPeerId,
  RoomDocs,
  writeDocument,
} from "@meridian/document-model";
import { nodeOf, blocksOf as shapeBlocksOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import type { PMNode } from "@meridian/markup";
import { isEmptyDocument, withoutBlockIds } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import type { z } from "zod";
import { applyEdits } from "../apply/apply-edits.js";
import { snapshotProjected } from "../apply/echo.js";
import { resolveOverwrite } from "../apply/overwrite.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { AgentEditCodecFactory } from "../codec-adapter.js";
import type { Block } from "../codec-types.js";
import { contentMerge } from "../content-merge/merge.js";
import { captureDelta } from "../content-merge/stands.js";
import { createWriteLinkAssigner, type WriteLinkAssigner } from "../links/assign-refs.js";
import type { SpliceFallback } from "../links/find-splice.js";
import { renderedItems, shownEvidence } from "../links/shown.js";
import { decodeFrontierMap, planningFrontiers } from "../loro-frontier.js";
import { fullHashForBlockId } from "../model/block-hash.js";
import {
  LoroDocument,
  type LoroDocumentModel,
  loroModel,
  toLoroHandle,
} from "../model/loro-model.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { isDocumentNotFoundError } from "../ports/document-coordinator.js";
import type {
  AgentEditRooms,
  AgentRoomRead,
  LoroDocumentEdits,
  LoroLinksPort,
} from "../ports/document-rooms.js";
import type { ProjectedBlock } from "../ports/model.js";
import { type AgentEditJournal, editHandle } from "../ports/update-journal.js";
import { landCopies } from "../resolver/land-copies.js";
import { planWrite, type ResolveWriteParams } from "../resolver/resolve.js";
import { type CommandLinks, openCommandLinks } from "./command-links.js";
import { ReadCommandSchema, WriteCommandSchema } from "./command-schema.js";
import { copySummary } from "./copy-receipt.js";
import { createDocumentRenderer, type ParseForCommandResult } from "./document-renderer.js";
import { documentNotFound, type InternalWriteResult } from "./internal-result.js";
import { recordLoroObservation } from "./loro-observation.js";
import type { AgentEditResultCommand } from "./model-result.js";
import type { ShownBlock } from "./read-view.js";
import { renderReceipt, returnedWriteResult } from "./receipt.js";
import { formatUnchangedSuccess, status, toOutcome } from "./response-format.js";
import type {
  DocumentCommandName,
  MutationActor,
  ReadCommand,
  ReadFunction,
  UnexpectedWriteErrorDetail,
  WriteCommand,
  WriteContext,
  WriteFunction,
  WriteOutcome,
} from "./types.js";
import type { ObservationFailedDetail } from "./write-deps.js";
import {
  createAutoTurnIdNonce,
  errorResponse,
  fallbackCommandName,
  parseFileAddress,
  readSuccess,
  writeError,
  writeSchemaError,
} from "./write-helpers.js";

export interface LoroEditCoreOptions {
  rooms: AgentEditRooms;
  journal: AgentEditJournal;
  schema: Schema;
  /** Parses purely; each command takes its codec for its prepared holder scope. */
  codec: AgentEditCodecFactory;
  /** A document's own codec where it is not `codec`: a code document's text is not Markdown. */
  codecFor?(documentId: string): Promise<AgentEditCodecFactory>;
  links: LoroLinksPort;
  documentEdits?: LoroDocumentEdits;
  /**
   * The chat a `turn:<id>` commit message names, as the model reads it (`agent (c15)`); null for a
   * turn the host can't trace. Absent: every turn but the reader's own is `another agent`.
   */
  authorOfTurn?(turnId: string): Promise<string | null>;
  defaultSessionId?: string;
  defaultThreadId?: string;
  onLinkSpliceFallback?: (event: { documentId: string; reason: SpliceFallback }) => void;
  onObservationFailed?: (event: ObservationFailedDetail) => void;
  onUnexpectedWriteError?: (event: UnexpectedWriteErrorDetail) => void;
}

export interface LoroEditCore {
  read: ReadFunction;
  write: WriteFunction;
  model: LoroDocumentModel;
}

type Address = Extract<ReturnType<typeof parseFileAddress>, { ok: true }>;

/** The commit message a write's ops carry: who the concurrent-change report names (design §5). */
export function commitMessageOf(actor: MutationActor): string | undefined {
  return actor.kind === "agent" ? `turn:${actor.turnId}` : undefined;
}

export function createLoroEditCore(options: LoroEditCoreOptions): LoroEditCore {
  const { schema, rooms } = options;
  const model = loroModel(schema);
  const renderer = createDocumentRenderer({ model });
  const localSessions = new Map<string, ActorSession>();
  const autoTurnIdNonce = createAutoTurnIdNonce();
  let autoTurnCounter = 0;

  const read: ReadFunction = async (command, context = {}) => {
    const parsed = ReadCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand("read", parsed.error);
    return execute("read", parsed.data, context, (valid, session) =>
      valid.format === "edits" ? readEdits(valid, session) : readDocumentCommand(valid, context),
    );
  };

  const write: WriteFunction = async (command, context = {}) => {
    const parsed = WriteCommandSchema.safeParse(command);
    if (!parsed.success) return invalidCommand(fallbackCommandName(command), parsed.error);
    return execute(parsed.data.command, parsed.data, context, (valid, session) => {
      switch (valid.command) {
        case "create":
        case "copy":
          return create(valid, session, context);
        case "insert":
        case "replace":
        case "remove":
          return mutate(valid, session, context);
        case "undo":
        case "revert":
          return inverse(valid, session);
      }
    });
  };

  return { read, write, model };

  function invalidCommand(commandName: AgentEditResultCommand, error: z.ZodError): WriteOutcome {
    return toOutcome(commandName, status("invalid_write", writeSchemaError(error)));
  }

  async function execute<
    Command extends { file: string; documentId?: string; tool_use_id?: string },
  >(
    commandName: DocumentCommandName,
    command: Command,
    context: WriteContext,
    run: (command: Command, session: ActorSession) => Promise<InternalWriteResult>,
  ): Promise<WriteOutcome> {
    const session = resolveSession(context);
    let result: InternalWriteResult;
    try {
      const address = parseFileAddress(command);
      result = address.ok ? await run(command, session) : status("invalid_write", address.message);
    } catch (cause) {
      if (!isDocumentNotFoundError(cause))
        options.onUnexpectedWriteError?.({
          cause,
          command: commandName,
          ...(command.documentId ? { documentId: command.documentId } : {}),
          sessionId: session.id,
          threadId: session.threadId,
          ...(context.turnId ? { turnId: context.turnId } : {}),
        });
      result = writeError(cause, commandName);
    }
    return toOutcome(commandName, result, command.file);
  }

  function resolveSession(context: WriteContext): ActorSession {
    if (context.session) return context.session;
    const actorThreadId =
      context.actor?.kind === "agent" || context.actor?.kind === "human"
        ? context.actor.threadId
        : undefined;
    const id = context.sessionId ?? options.defaultSessionId ?? "default-session";
    const threadId = actorThreadId ?? context.threadId ?? options.defaultThreadId ?? id;
    const existing = localSessions.get(id);
    if (existing) return existing;
    const session: ActorSession = { id, threadId };
    localSessions.set(id, session);
    return session;
  }

  /** The call's room copy, freed when `use` settles; a missing document answers its result. */
  async function withRoom(
    documentId: string,
    commandName: DocumentCommandName,
    use: (read: AgentRoomRead, copy: LoroDocument) => Promise<InternalWriteResult>,
  ): Promise<InternalWriteResult> {
    let read: AgentRoomRead;
    try {
      read = await rooms.readRoom(documentId);
    } catch (cause) {
      if (!isDocumentNotFoundError(cause)) throw cause;
      return documentNotFound(commandName, cause);
    }
    try {
      return await use(read, new LoroDocument(read.docs, schema));
    } finally {
      read.docs.free();
    }
  }

  async function links(
    documentId: string,
    copy: LoroDocument,
    context: WriteContext,
    extra: {
      written?: readonly PMNode[];
      stored?: readonly PMNode[];
      shown?: Awaited<ReturnType<NonNullable<WriteContext["shownLinks"]>>>;
    } = {},
  ): Promise<CommandLinks> {
    return openCommandLinks(options, {
      documentId,
      docs: [],
      stored: [...blocksOf(copy), ...(extra.stored ?? [])],
      ...(extra.written ? { written: extra.written } : {}),
      ...(extra.shown ? { shown: extra.shown } : {}),
      context,
    });
  }

  function blocksOf(copy: LoroDocument): PMNode[] {
    return copy.top().map((block) => nodeOf(schema, block));
  }

  function revision(copy: LoroDocument, scope: CommandLinks["scope"]): string {
    return options.links.revision(
      { version: encodeRoomVersion(copy.docs.version()), blocks: blocksOf(copy) },
      scope,
    );
  }

  async function readDocumentCommand(
    command: ReadCommand,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command) as Address;
    return withRoom(address.documentId, "read", async (room, copy) => {
      const commandLinks = await links(address.documentId, copy, context);
      const selection = renderer.selectReadBlocks(toLoroHandle(copy), command, address);
      if (!selection.ok)
        return errorResponse(
          selection.code,
          selection.message,
          address.filePath,
          selection.documentBlocks,
        );
      const rendered = renderer.renderRead(
        selection,
        commandLinks.codec,
        command.format === "outline" ? "outline" : "full",
      );
      return withEvidence(commandLinks, room, copy, address.documentId, context, {
        ...readSuccess(rendered),
        revision: revision(copy, commandLinks.scope),
        ...(context.includeNodes ? { nodes: selection.selected.map((block) => block.node) } : {}),
      });
    });
  }

  async function readEdits(command: ReadCommand, session: ActorSession) {
    const port = options.documentEdits;
    if (!port) return status("invalid_write", "This host has no edit history.");
    const address = parseFileAddress(command) as Address;
    const result = await port.read({ documentId: address.documentId, threadId: session.threadId });
    if (result.status !== "success") return status(result.status, result.message);
    return {
      status: "success" as const,
      phase: "committed" as const,
      model: { message: result.message, read: { format: "edits" as const } },
    };
  }

  async function inverse(
    command: Extract<WriteCommand, { command: "undo" | "revert" }>,
    session: ActorSession,
  ): Promise<InternalWriteResult> {
    const port = options.documentEdits;
    if (!port) return status("invalid_write", "This host has no edit history.");
    const address = parseFileAddress(command) as Address;
    const result = await port.execute({
      documentId: address.documentId,
      threadId: session.threadId,
      command,
    });
    if (result.status !== "success") return status(result.status, result.message);
    return {
      status: "success",
      phase: "committed",
      ...(result.writeId ? { writeId: result.writeId } : {}),
      model: { message: result.message },
    };
  }

  /**
   * The document a write plans on: a view of the room at the frontiers the model read plus the
   * reply's own writes since (`RoomDocs.at`), or the room copy itself when no read was recorded (a
   * utility write, or a write to a document the model never read), or an empty view for a document
   * this reply created. `uncomparable` when the model read the room but its frontiers can no longer
   * be checked out (below the history cutoff): a replace then plans on the transcript. The caller
   * frees `view`.
   */
  async function planningDoc(
    read: AgentRoomRead,
    copy: LoroDocument,
    documentId: string,
    context: WriteContext,
    actor: MutationActor,
  ): Promise<{ doc: LoroDocument; view: RoomDocs | null; uncomparable?: true }> {
    const lookups = context.frontiers;
    if (!lookups?.planning) {
      if (lookups && context.responseIdentity && actor.kind === "agent")
        throw new Error(`A reply's write to ${documentId} carries no planning frontier`);
      return { doc: copy, view: null };
    }
    const room = loroRoomName(read.room);
    const frontier = await lookups.planning(room);
    const recorded = frontier?.room === room ? decodeFrontierMap(frontier.snapshot) : null;
    const own = lookups.reply?.updates(documentId) ?? [];
    const at = recorded ? planningFrontiers(read.docs, recorded, own) : null;
    const created = !at && Boolean(lookups.reply?.created(documentId));
    const frontiers = at ?? (created ? new Map([["s", []]]) : null);
    if (!frontiers) return { doc: copy, view: null, ...(recorded ? { uncomparable: true } : {}) };
    const view = read.docs.at(frontiers, freshServerPeerId());
    return { doc: new LoroDocument(view, schema), view };
  }

  async function create(
    command: Extract<WriteCommand, { command: "create" | "copy" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command) as Address;
    if (address.fragment)
      return status("invalid_write", `${command.command} does not accept a #fragment in file.`);
    if (command.command === "copy" && !context.copiedNodes)
      return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    const actor = mutationActor(session, address.documentId, context);
    const copiedNodes =
      command.command === "copy" && context.copiedNodes
        ? landCopies(context.copiedNodes, null)
        : undefined;
    const content = command.command === "create" ? (command.content ?? "") : "";
    const boundNodes = command.command === "create" ? context.boundNodes : undefined;
    const given = copiedNodes ?? boundNodes;
    const parsed: ParseForCommandResult = given
      ? { ok: true, parsed: { blocks: [...given] } }
      : renderer.parseForCommand(
          (await options.codecFor?.(address.documentId)) ?? options.codec,
          content,
        );
    if (!parsed.ok) return status("invalid_write", parsed.message);
    const occupied: InternalWriteResult = {
      ...status("invalid_write", `${address.filePath} holds text; nothing was written.`),
      occupied: true,
    };
    return withRoom(address.documentId, command.command, async (read, copy) => {
      const existing = !isEmptyDocument(blocksOf(copy));
      if (existing && command.overwrite !== true) return occupied;
      const planned = existing
        ? await planningDoc(read, copy, address.documentId, context, actor)
        : { doc: copy, view: null };
      try {
        const shown = given ? [] : ((await context.shownLinks?.(address.documentId)) ?? []);
        const commandLinks = await links(address.documentId, planned.doc, context, {
          ...(given ? { stored: given } : { written: parsed.parsed.blocks }),
          shown,
        });
        const assigner = linkAssigner(address.documentId, commandLinks, shown, context);
        let plan: Plan;
        if (existing) {
          const resolved = resolveOverwrite(
            {
              doc: toLoroHandle(planned.doc),
              model,
              codec: commandLinks.codec,
              links: boundNodes ? "preassigned" : assigner,
            },
            address,
            copiedNodes ? { blocks: copiedNodes } : { content, parsedContent: parsed.parsed },
            given ? given.length === 0 : content.length === 0,
          );
          if (!resolved.ok)
            return errorResponse(resolved.error.code, resolved.error.message, address.filePath);
          if (resolved.edits.length === 0)
            return await withEvidence(commandLinks, read, copy, address.documentId, context, {
              ...formatUnchangedSuccess(),
            });
          plan = { edits: resolved.edits };
        } else {
          plan = {
            blocks: given ? parsed.parsed.blocks : assigner.assignSpan([], parsed.parsed.blocks),
          };
        }
        const result = await finish({
          command,
          session,
          context,
          read,
          copy,
          planDoc: planned.doc,
          assigner,
          links: commandLinks,
          actor,
          address,
          plan,
          ...(copiedNodes
            ? {
                copied: {
                  from: command.command === "copy" ? command.from.path : "",
                  edges: false,
                },
              }
            : {}),
        });
        // The document began empty for the model: its later writes in this reply plan from that.
        if (!existing && result.status === "success")
          context.frontiers?.reply?.noteCreated(address.documentId);
        return result;
      } finally {
        planned.view?.free();
      }
    });
  }

  async function mutate(
    command: Extract<WriteCommand, { command: "insert" | "replace" | "remove" }>,
    session: ActorSession,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const address = parseFileAddress(command) as Address;
    const from = command.command === "remove" ? undefined : command.from;
    const copiedNodes = from ? context.copiedNodes : undefined;
    if (from && !copiedNodes) return status("invalid_write", MISSING_COPIED_NODES_MESSAGE);
    if (copiedNodes?.length === 0)
      return status("invalid_write", `from selected no blocks in ${from?.path}.`);
    const { from: _from, ...selectors } = command as typeof command & { from?: unknown };
    const actor = mutationActor(session, address.documentId, context);
    return withRoom(address.documentId, command.command, async (read, copy) => {
      const planned = await planningDoc(read, copy, address.documentId, context, actor);
      try {
        const shown = copiedNodes ? [] : ((await context.shownLinks?.(address.documentId)) ?? []);
        const commandLinks = await links(address.documentId, planned.doc, context, {
          ...(copiedNodes ? { stored: copiedNodes } : {}),
          shown,
        });
        let params: ResolveWriteParams = {
          ...selectors,
          documentAddress: address,
          ...(copiedNodes ? { blocks: copiedNodes } : {}),
        };
        if (
          planned.uncomparable &&
          command.command === "replace" &&
          !copiedNodes &&
          command.find === undefined &&
          command.content !== undefined
        ) {
          const view = context.linkView?.kind === "draft" ? "draft" : "live";
          const shownBlocks =
            (await context.frontiers?.planningShown?.(loroRoomName(read.room))) ?? [];
          const merged = transcriptMerge(
            copy,
            shownBlocks.filter((block) => block.view === view),
            commandLinks,
            params,
            linkAssigner(address.documentId, commandLinks, shown, context),
          );
          if (merged !== null)
            params = {
              ...params,
              in: undefined,
              around: undefined,
              content: merged,
              wholeDocument: true,
            };
        }
        const resolveOn = async (doc: LoroDocument) => {
          const plan = planWrite(
            { doc: toLoroHandle(doc), model, codec: commandLinks.codec },
            params,
          );
          if (plan.ok && plan.written.length > 0)
            await options.links.prepare({
              documentId: address.documentId,
              docs: [],
              written: plan.written,
              context,
            });
          const assigner = linkAssigner(address.documentId, commandLinks, shown, context);
          return { assigner, resolved: plan.ok ? plan.assign(assigner) : plan };
        };
        let planDoc = planned.doc;
        let { assigner, resolved } = await resolveOn(planDoc);
        // A find names text, not blocks: when what it matched in the view is gone from the room,
        // it matches the room as it is now.
        if (
          resolved.ok &&
          planDoc !== copy &&
          missingTarget(resolved.edits, copy) &&
          "find" in command &&
          command.in === undefined
        ) {
          planDoc = copy;
          ({ assigner, resolved } = await resolveOn(planDoc));
        }
        if (!resolved.ok) {
          const failed = errorResponse(
            resolved.error.code,
            resolved.error.message,
            address.filePath,
            typeof resolved.error.details?.documentBlocks === "number"
              ? resolved.error.details.documentBlocks
              : undefined,
          );
          // A hash or number the view does not hold: the answer shows the document, and the next
          // write plans on it.
          return resolved.error.code === "not_found"
            ? withCurrentText(failed, read, copy, commandLinks, address, context)
            : failed;
        }
        if (resolved.edits.length === 0)
          return await withEvidence(
            commandLinks,
            read,
            copy,
            address.documentId,
            context,
            formatUnchangedSuccess(),
          );
        return await finish({
          command,
          session,
          context,
          read,
          copy,
          planDoc,
          assigner,
          links: commandLinks,
          actor,
          address,
          plan: { edits: resolved.edits },
          ...(from && copiedNodes ? { copied: { from: from.path, edges: true } } : {}),
        });
      } finally {
        planned.view?.free();
      }
    });
  }

  type Plan = { edits: readonly ResolvedEdit[] } | { blocks: readonly Block[] };

  /**
   * A whole-document replace's content that writes the model's command as a merge with what it
   * read, when its frontiers are below the history cutoff (design §5): base is each block as a
   * result last showed it in full (else the room's), ours is the command applied to base, theirs
   * is the room. Without it an old chat's write would bring back text the writer deleted since.
   * Null when no shown block matches the room, a body doesn't parse as one block, or the command
   * doesn't resolve on the read.
   */
  function transcriptMerge(
    copy: LoroDocument,
    shown: readonly ShownBlock[],
    commandLinks: CommandLinks,
    params: ResolveWriteParams,
    assigner: WriteLinkAssigner,
  ): string | null {
    const now = copy.top();
    const full = now.map((block) => ({ id: block.id, hash: fullHashForBlockId(block.id) }));
    const bodies = new Map<string, string>();
    for (const block of shown) {
      const prefix = block.hash.trim().toLowerCase();
      const matches = full.filter((candidate) => candidate.hash.startsWith(prefix));
      if (matches.length === 1) bodies.set(matches[0].id, block.body);
    }
    if (bodies.size === 0) return null;
    const theirs = blocksOf(copy);
    const base: PMNode[] = [];
    for (const [index, block] of now.entries()) {
      const body = bodies.get(block.id);
      if (body === undefined) {
        base.push(theirs[index]);
        continue;
      }
      const parsed = commandLinks.codec.parse(body).blocks;
      if (parsed.length !== 1) return null;
      base.push(withId(parsed[0] as PMNode, block.id));
    }
    const scratch = RoomDocs.create(shapeSchemaOf(schema), freshServerPeerId());
    try {
      writeDocument(scratch, shapeBlocksOf(schema.topNodeType.create(null, base)));
      const read = new LoroDocument(scratch, schema);
      const plan = planWrite({ doc: toLoroHandle(read), model, codec: commandLinks.codec }, params);
      const resolved = plan.ok ? plan.assign(assigner) : plan;
      if (!resolved.ok || !applyEdits(toLoroHandle(read), model, resolved.edits, "read-view").ok)
        return null;
      const merged = contentMerge(schema, base, theirs, blocksOf(read));
      return commandLinks.codec.serialize(
        merged.blocks.map((block) => withoutBlockIds(block) as PMNode),
      );
    } finally {
      scratch.free();
    }
  }

  function withId(node: PMNode, id: string): PMNode {
    const json = node.toJSON() as { attrs?: Record<string, unknown> };
    return schema.nodeFromJSON({ ...json, attrs: { ...json.attrs, id } });
  }

  /** One write landing: applied on its plan doc, exported as one batch, saved with its record. */
  async function finish(edit: {
    command: WriteCommand;
    session: ActorSession;
    context: WriteContext;
    read: AgentRoomRead;
    /** The call's room copy: the echo, the delta and the recorded frontier read it. */
    copy: LoroDocument;
    /** What the write plans and applies on: the model's view, or the room copy itself. */
    planDoc: LoroDocument;
    assigner: WriteLinkAssigner;
    links: CommandLinks;
    actor: MutationActor;
    address: Address;
    plan: Plan;
    copied?: { from: string; edges: boolean };
  }): Promise<InternalWriteResult> {
    const { command, session, context, read, copy, planDoc, actor, address, plan } = edit;
    const docId = address.documentId;
    // The writer removed what the model named since its read: its words would bring it back.
    if (planDoc !== copy && "edits" in plan && missingTarget(plan.edits, copy))
      return withCurrentText(
        returnedWriteResult("block_gone"),
        read,
        copy,
        edit.links,
        address,
        context,
      );
    if (edit.assigner.minted.length > 0) {
      await options.links.registerAhead(edit.assigner.minted);
      await options.links.prepare({
        documentId: docId,
        docs: [],
        refs: edit.assigner.minted.map((mint) => mint.ref),
        addresses: edit.assigner.minted.map((mint) => mint.address),
        context,
      });
    }
    const identity = await nextWriteIdentity(docId, session, context, command.tool_use_id);
    const planned = snapshotProjected(model.projectBlocks(toLoroHandle(planDoc)), edit.links.codec);
    const textBefore = blocksOf(copy);
    const since = read.docs.shownVersion();
    planDoc.write = { message: commitMessageOf(actor) };
    let changed: string[] = [];
    let deleted: string[] = [];
    let inserted: string[] = [];
    if ("edits" in plan) {
      const applied = applyEdits(toLoroHandle(planDoc), model, plan.edits, "agent-write");
      if (!applied.ok)
        return errorResponse(applied.error.code, applied.error.message, address.filePath);
      ({ changedBlocks: changed, deletedBlocks: deleted, insertedBlocks: inserted } = applied);
    } else {
      inserted = model
        .insertBlocks(toLoroHandle(planDoc), null, { blocks: [...plan.blocks] })
        .map((ref) => model.getBlockId(ref));
      changed = inserted;
    }
    const touchedKeys = planDoc
      .top()
      .filter((block) => changed.includes(planDoc.hashOf(block.id)))
      .map((block) => block.id);
    const deletedKeys = planned
      .filter((block) => deleted.includes(block.hash))
      .map((block) => block.key);
    const exported = (planDoc === copy ? copy.docs : planDoc.docs).exportSince(since);
    if (exported.size === 0)
      return withEvidence(edit.links, read, copy, docId, context, formatUnchangedSuccess());
    const batch = encodeEnvelope(exported);
    // The echo, the delta and the frontier show the write merged into the room as this call read
    // it, the writer's surviving words included.
    if (planDoc !== copy) copy.docs.importBatch(decodeEnvelope(batch));
    copy.forget();
    const textAfter = blocksOf(copy);
    await rooms.save(read.room, batch, {
      documentId: docId,
      writeId: identity.durableId,
      wId: identity.ordinal,
      ...(identity.toolCallId ? { toolCallId: identity.toolCallId } : {}),
      threadId: session.threadId,
      turnId: actor.kind === "agent" ? actor.turnId : null,
      ...(actor.kind === "agent" && actor.responseId
        ? { authoringResponseId: actor.responseId }
        : {}),
      actor,
      delta: captureDelta(textBefore, textAfter),
    });
    context.frontiers?.reply?.append(docId, [batch]);
    const echoProjected = model.projectBlocks(toLoroHandle(copy));
    const result = renderReceipt(
      {
        commandName: command.command,
        writeId: editHandle(identity.ordinal),
        durableWriteId: identity.durableId,
        touchedBlocks: touchedKeys,
        deletedBlocks: deletedKeys,
        ...(edit.copied ? { copied: copySummary(edit.copied.from, inserted, edit.copied) } : {}),
      },
      planned,
      snapshotProjected(echoProjected, edit.links.codec),
      {
        phase: "committed",
        revision: revision(copy, edit.links.scope),
        writeId: editHandle(identity.ordinal),
        awarenessDegraded: false,
      },
    );
    return withEvidence(edit.links, read, copy, docId, context, result, {
      ownRemoved: new Set(deletedKeys),
      projected: echoProjected,
    });
  }

  function withEvidence(
    commandLinks: CommandLinks,
    read: AgentRoomRead,
    copy: LoroDocument,
    documentId: string,
    context: WriteContext,
    result: InternalWriteResult,
    own: { ownRemoved?: ReadonlySet<string>; projected?: readonly ProjectedBlock[] } = {},
  ): Promise<InternalWriteResult> {
    return recordLoroObservation(result, {
      copy,
      model,
      room: loroRoomName(read.room),
      recording: context.frontiers?.recording,
      ownTurn: context.turnId ?? null,
      ownRemoved: own.ownRemoved ?? new Set(),
      projected: own.projected ?? model.projectBlocks(toLoroHandle(copy)),
      authorOfTurn: options.authorOfTurn,
      onFailed: (cause) => options.onObservationFailed?.({ documentId, cause }),
    }).then((observed) => ({
      ...observed,
      ...shownEvidence(renderedItems(observed.model), commandLinks),
    }));
  }

  /**
   * `result` with the document as the room holds it now, recorded as the model's latest view: an
   * answer about a view that lost what it named carries the text the next write plans on.
   */
  function withCurrentText(
    result: InternalWriteResult,
    read: AgentRoomRead,
    copy: LoroDocument,
    commandLinks: CommandLinks,
    address: Address,
    context: WriteContext,
  ): Promise<InternalWriteResult> {
    const selection = renderer.selectReadBlocks(
      toLoroHandle(copy),
      { file: address.filePath },
      address,
    );
    if (!selection.ok) return Promise.resolve(result);
    const { model: payload } = readSuccess(
      renderer.renderRead(selection, commandLinks.codec, "full"),
    );
    return withEvidence(commandLinks, read, copy, address.documentId, context, {
      ...result,
      model: { ...result.model, ...payload },
      revision: revision(copy, commandLinks.scope),
    });
  }

  /** An edit naming a block the room no longer shows; an insert after a removed block is new words. */
  function missingTarget(edits: readonly ResolvedEdit[], current: LoroDocument): boolean {
    return edits.some((edit) => {
      if (edit.kind === "insert" || !edit.block) return false;
      return current.shape((edit.block as unknown as { id: string }).id) === undefined;
    });
  }

  function linkAssigner(
    documentId: string,
    commandLinks: CommandLinks,
    shown: Parameters<typeof createWriteLinkAssigner>[0]["shown"],
    context: WriteContext,
  ): WriteLinkAssigner {
    return createWriteLinkAssigner({
      scope: commandLinks.scope,
      shown,
      ...(context.uploadsChat ? { uploadsChat: context.uploadsChat } : {}),
      ...(options.onLinkSpliceFallback
        ? { onSpliceFallback: (reason) => options.onLinkSpliceFallback?.({ documentId, reason }) }
        : {}),
    });
  }

  async function nextWriteIdentity(
    docId: string,
    session: ActorSession,
    context: WriteContext,
    commandToolUseId?: string,
  ) {
    const ordinal = await options.journal.reserveWriteOrdinal(docId, session.threadId);
    const toolCallId = commandToolUseId ?? context.tool_use_id;
    // Scoped to the turn so the same tool-call id in another turn is another write.
    const durableId =
      (toolCallId && context.turnId ? `turn:${context.turnId}:tool:${toolCallId}` : toolCallId) ??
      globalThis.crypto?.randomUUID?.() ??
      `${session.threadId}:${docId}:write-${ordinal}`;
    return { durableId, ordinal, ...(toolCallId ? { toolCallId } : {}) };
  }

  function mutationActor(
    session: ActorSession,
    docId: string,
    context: WriteContext,
  ): MutationActor {
    if (context.actor) return context.actor;
    const turnId =
      context.turnId ??
      `${session.threadId}:${docId}:turn-${autoTurnIdNonce}-${(++autoTurnCounter).toString(36)}`;
    return {
      kind: "agent",
      turnId,
      threadId: session.threadId,
      responseId: context.responseIdentity?.modelResponseId,
    };
  }
}

const MISSING_COPIED_NODES_MESSAGE = "This deployment can't copy: the source blocks are missing.";
