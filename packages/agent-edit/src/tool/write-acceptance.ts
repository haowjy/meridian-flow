// Acceptance, captured updates and evidence for prepared document writes.
import { allocateDocumentClient } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { applyEdits } from "../apply/apply-edits.js";
import { snapshotBlocks } from "../apply/echo.js";
import type { ResolvedEdit } from "../apply/types.js";
import type { Block } from "../codec-types.js";
import { toDocHandle, toRef } from "../handles.js";
import { intersectLineageRanges } from "../lineage/range-set.js";
import type { WriteLinkAssigner } from "../links/assign-refs.js";
import { getTopLevelXmlBlocks } from "../model/block-hash.js";
import type { ActorSession } from "../ports/actor-session-store.js";
import { writeHandle } from "../ports/update-journal.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import type { CommandLinks } from "./command-links.js";
import { copySummary } from "./copy-receipt.js";
import { mutationMode } from "./interaction-mode.js";
import type { InternalWriteResult } from "./internal-result.js";
import { isInternalWriteResult } from "./internal-result.js";
import { modelBlockItem } from "./model-result.js";
import { type ListingSource, recordObservation } from "./observation.js";
import { renderReceipt, withRefusedPassages } from "./receipt.js";
import {
  createRegionCheck,
  REFUSAL_REGION_MAX_BYTES,
  type RegionRefusalReason,
} from "./region-check.js";
import type { ResponseCommitter, RoomCopy } from "./response-committer.js";
import { formatApplySuccess, formatUnchangedSuccess, status } from "./response-format.js";
import type { MutationActor, WriteCommand, WriteContext } from "./types.js";
import type { CreateWriteToolOptions } from "./write-deps.js";
import { errorResponse, mutationMeta } from "./write-helpers.js";
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

/**
 * What a write's region check reads: the unshown blocks of what its view was planned from, null
 * when the room has no valid planning frontier, or `exempt` (creating a document, initializing
 * an empty one, or a write that belongs to no model reply).
 */
export type Planned = { unshown: readonly string[] } | null | "exempt";

/** An atomic passage; groups have independent, non-overlapping target windows. */
export interface PreparedEditGroup {
  edits: readonly ResolvedEdit[];
  targets: readonly number[] | "all";
}

export interface PreparedEdit {
  command: WriteCommand;
  session: ActorSession;
  context: WriteContext;
  /** The call's room copy: the echo and the recorded frontier render from it. */
  room: RoomCopy;
  /** What the write plans and applies on: the model's view, or the room copy itself. */
  planDoc: Y.Doc;
  /** What the region check reads; `exempt` skips it. */
  planned: Planned;
  /** Refs the write minted, registered once the write is past its region check. */
  assigner: WriteLinkAssigner;
  links: CommandLinks;
  actor: MutationActor;
  docId: string;
  filePath: string;
  plan:
    | { groups: readonly PreparedEditGroup[]; ir: SemanticEditIRV1 }
    | { blocks: readonly Block[] };
  creation?: { createdDocument: boolean; refuseUnlessEmpty?: InternalWriteResult };
  copy?: { from: string; edges: boolean };
}

export function createWriteAcceptance(deps: {
  options: Pick<
    CreateWriteToolOptions,
    "model" | "semanticProvenance" | "links" | "onObservationFailed"
  >;
  journal: CreateWriteToolOptions["journal"];
  responseCommitter: ResponseCommitter;
}) {
  const { options, journal, responseCommitter } = deps;
  return { finishPreparedEdit, withEvidence };
  /** One acceptance boundary for every edit; report failures cannot enter its restoration path. */
  async function finishPreparedEdit(edit: PreparedEdit): Promise<InternalWriteResult> {
    const { command, session, context, room, planDoc, links, actor, docId, filePath, plan } = edit;
    const accepted: PreparedEditGroup[] = [];
    const refusals: Array<{ blocks: Y.XmlElement[]; reason: RegionRefusalReason }> = [];
    // Empty-document creation is the one unchecked plan; each ordinary command has one group.
    if ("groups" in plan) {
      const check =
        edit.planned === "exempt"
          ? null
          : createRegionCheck({
              planDoc,
              room: room.doc,
              planned: edit.planned,
            });
      for (const group of plan.groups) {
        if (!group.edits.length) continue;
        const refusal = check?.(group.targets);
        if (refusal) refusals.push(refusal);
        else accepted.push(group);
      }
      if (!accepted.length) {
        if (!refusals.length) return formatUnchangedSuccess();
        const refused = new Set(refusals.flatMap((refusal) => refusal.blocks));
        const blocks = getTopLevelXmlBlocks(room.doc).filter((block) => refused.has(block));
        return refuseRegion(edit, blocks, refusals[0].reason);
      }
    }
    const refusedPassages = refusals.map(({ blocks }) =>
      blocks.map((block) => options.model.getCanonicalBlockIdentity(toRef(block))),
    );
    const edits = accepted.flatMap((group) => group.edits);
    let semanticEditIr = "ir" in plan ? plan.ir : undefined;
    if (semanticEditIr && refusals.length) {
      if (semanticEditIr.intent.kind !== "mappedEdits")
        throw new Error("A partially accepted plan requires mapped semantic edits");
      // Groups are independent passages; only accepted targets can declare deleted lineage.
      const acceptedScope = edits.flatMap((part) =>
        part.kind === "insert" ? [] : options.model.getVisibleContentLineage(part.block),
      );
      const acceptedEdits = new Set(edits);
      semanticEditIr = {
        ...semanticEditIr,
        deleted: intersectLineageRanges(semanticEditIr.deleted, acceptedScope),
        intent: {
          kind: "mappedEdits",
          edits: semanticEditIr.intent.edits.filter(({ edit }) => acceptedEdits.has(edit)),
        },
      };
    }
    await registerMinted(edit.assigner, docId, context);
    const identity = await nextWriteIdentity(docId, session, context, command.tool_use_id);
    const editScopeId = context.responseIdentity?.editScopeId;
    const staged = Boolean(editScopeId) && actor.kind === "agent";
    // A save's first entry keeps the room's cut: reconcile reads what retired since.
    const cut =
      staged && editScopeId && responseCommitter.hasScopeCut(editScopeId, docId)
        ? undefined
        : { generation: room.generation, snapshot: Y.encodeSnapshotV2(Y.snapshot(room.doc)) };
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
    const captured = captureWriteUpdate<import("../apply/types.js").ApplyResult>(
      planDoc,
      roomClients,
      (beforeSegment) => {
        if ("groups" in plan)
          return applyEdits(
            toDocHandle(planDoc),
            options.model,
            edits,
            origin,
            beforeSegment,
            certifySegment(planDoc, semanticEditIr as SemanticEditIRV1, beforeVector),
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
        refusedPassages,
        preOwnSnapshot,
        semanticEditIr,
        copied,
        interactionContext,
        ...(context.frontiers?.reply ? { reply: context.frontiers.reply } : {}),
      });
      if (rejected) return withRefusedPassages(rejected, refusedPassages);
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
      if (isInternalWriteResult(saved)) return withRefusedPassages(saved, refusedPassages);
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
            refusedPassages,
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
        withRefusedPassages(
          formatApplySuccess({ ...outcome, echo: [], awarenessDegraded: true }),
          refusedPassages,
        ),
        { ownRemoved },
      );
    }
  }

  /**
   * The region check's refusal: why, and the region's current text from the room copy, recorded
   * like a read so the next attempt proceeds unless the passage changes again. A region too
   * long to show names its range to read instead, and records nothing.
   */
  function refuseRegion(
    edit: PreparedEdit,
    blocks: readonly Y.XmlElement[],
    reason: RegionRefusalReason,
  ) {
    const items = options.model
      .serializeBlockLines(toDocHandle(edit.room.doc), edit.links.codec, blocks.map(toRef))
      .map(modelBlockItem);
    const bytes = new TextEncoder().encode(items.map((item) => item.body).join("\n")).byteLength;
    const first = items[0],
      last = items.at(-1);
    const why =
      reason === "changed"
        ? "Not applied: this passage changed since you last saw it"
        : "Not applied: you haven't seen all of this passage yet";
    if (
      bytes > REFUSAL_REGION_MAX_BYTES &&
      first &&
      last &&
      (!("groups" in edit.plan) || edit.plan.groups.length === 1)
    )
      return status(
        "region_changed",
        `${why}, and it is too long to show here. Read it with read({"path": ${JSON.stringify(edit.filePath)}, "in": [${JSON.stringify(first.hash)}, ${JSON.stringify(last.hash)}]}), then write again.`,
      );
    return withEvidence(edit.links, edit.room, edit.docId, edit.context, {
      status: "region_changed",
      model: {
        message: `${why}. Current text:`,
        ...(items.length > 0 ? { blocks: [{ extent: "full", relation: "document", items }] } : {}),
      },
    });
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
      { doc: room.doc, model: options.model, links, ...own },
      room.room,
      context.frontiers?.recording,
      documentId,
      options.onObservationFailed,
    );
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
