/**
 * Server-side full-document markdown SET/read engine for collab documents.
 *
 * This intentionally stays out of `@meridian/agent-edit`: full-document SET is a
 * Meridian server persistence/read-model concern, built only by orchestrating the
 * package codec/model, Yjs fragment helper, journal, and document coordinator.
 */

import type { TransactionOrigin } from "@hocuspocus/server";
import {
  createAgentEditCodecFactory,
  fragmentOf,
  isDocumentNotFoundError,
  type MutationActor,
  overwriteWithAssigned,
  renderAgentEditResult,
  toDocHandle,
  type UpdateJournal,
  type UpdateMeta,
  type WriteOutcome,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { DocumentLinkScope, MarkupCodec, ParsedContent } from "@meridian/markup";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  DocumentSeedOrigin,
  DocumentWriteOrigin,
  DocumentWriteResult,
  HeldLiveDocument,
  HeldWriteExpectation,
  HeldWriteStaged,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "../contracts.js";
import { documentAuthority } from "./document-handle.js";
import { type AuthorshipSource, admitFreshAuthorship } from "./document-mutation-policy.js";
import { versioned } from "./document-revision.js";
import type { BoundWrite } from "./link-binding.js";
import {
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";
import type { InitialDocumentSeeds } from "./ports/initial-document-seeds.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";
import { storedDocument } from "./stored-document.js";

export type RuntimeOrigin = UpdateOrigin | DocumentWriteOrigin;

export type MarkdownSetResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Uint8Array;
  meta: UpdateMeta;
};

type MarkdownWriteHook = (event: {
  documentId: DocumentId;
  threadId?: ThreadId;
  markdown: string;
}) => Promise<void>;

export type MarkdownSerializationAnomaly = {
  documentId: DocumentId;
  schemaVersion: typeof COLLAB_SCHEMA_VERSION;
  deletedNodeTypes: string[];
  deletedClockCount: number;
};

export type MarkdownSerializationAnomalyObserver = (anomaly: MarkdownSerializationAnomaly) => void;

type MarkdownDocumentEngineDeps = {
  codec: MarkupCodec;
  /**
   * The operation's document-link scope: each method prepares it with the
   * document it is about to spell, then serializes through the holder. The
   * scope doors (`document-link-scope-doors.ts`) open it.
   */
  links: DocumentLinkScopes;
  model: YProsemirrorDocumentModel;
  journal: UpdateJournal;
  coordinator: Pick<LiveDocumentCoordinator, "withDocument" | "deliver">;
  initialDocumentSeeds: InitialDocumentSeeds;
  metaForOrigin(origin: RuntimeOrigin): UpdateMeta;
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  afterWrite?: MarkdownWriteHook;
  /**
   * A whole-document write recorded as an actor's mutation (thread undo,
   * receipts): agent-edit's `create` applies the bound nodes as its ordinary
   * overwrite, or, bound fresh, into an empty document only.
   */
  identityPreservingWrite(input: {
    documentId: DocumentId;
    content: BoundWrite;
    actor: MutationActor;
  }): Promise<WriteOutcome>;
  resolveFiletype?(documentId: DocumentId): Promise<string | null>;
  observeSerializationAnomaly?: MarkdownSerializationAnomalyObserver;
};

/**
 * When a write's projection hook runs: with the write, or once the caller's transaction
 * commits (see `replaceLiveDocumentMarkdown`).
 */
type WriteHook = { kind: "now" } | { kind: "after-commit"; threadId?: ThreadId };

/** Stages a change on a copy of the live document, under its lock. */
type DraftMutation = (
  draft: Y.Doc,
  yjsOrigin: TransactionOrigin,
) => Result<void, SyncError> | Promise<Result<void, SyncError>>;

export type MarkdownDocumentEngine = {
  /** `view` is the version `doc` is: a Work draft's links spell in its branch's view. */
  serializeDocument(documentId: DocumentId, doc: Y.Doc, view: LinkView): Promise<string>;
  /** `view` is the version `doc` is: a Work draft's links spell in its branch's view. */
  serializeVersionedDocument(
    documentId: DocumentId,
    doc: Y.Doc,
    view: LinkView,
  ): Promise<{ content: string; revision: string }>;
  /**
   * The markdown of a document's stored state, whatever its lifecycle (a trashed document keeps
   * its state until purge); empty when it holds none. Reads the journal, never a live room.
   */
  readFrozenMarkdown(documentId: DocumentId): Promise<string>;
  readVersionedMarkdown(
    documentId: string,
  ): Promise<Result<{ content: string; revision: string }, SyncError>>;
  restoreFromYDoc(
    documentId: DocumentId,
    snapshot: Y.Doc,
    origin: RuntimeOrigin,
  ): Promise<Result<MarkdownSetResult, SyncError>>;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  /**
   * Whole-document writes take a write a `LinkBinder` bound before the
   * caller's transaction (contract §6.2); none of them parses Markdown. Each
   * applies only to the holder it was bound for, as the whole-document
   * overwrite of what the document holds. A fresh write that finds content
   * it never saw is `stale_generation`.
   */
  setMarkdown(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>>;
  /**
   * Gives a document with no state its authority, seeded empty (a create, or the repair of an
   * old anomaly); a no-op when any checkpoint or update exists.
   */
  ensureDocumentAuthority(documentId: DocumentId): Promise<void>;
  /** Writes only a document with no state yet; otherwise a no-op. Takes fresh writes only. */
  seedFromMarkdown(
    documentId: string,
    content: BoundWrite,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  withLiveDocument<T>(
    documentId: string,
    operation: (held: HeldLiveDocument) => Promise<T>,
  ): Promise<T>;
  writeDocumentHeld(input: {
    held: HeldLiveDocument;
    content: BoundWrite;
    expected: HeldWriteExpectation;
    origin: DocumentWriteOrigin | DocumentSeedOrigin;
    threadId?: ThreadId;
  }): Promise<Result<HeldWriteStaged, SyncError>>;
};

export function createMarkdownDocumentEngine(
  deps: MarkdownDocumentEngineDeps,
): MarkdownDocumentEngine {
  const agentEditCodecs = createAgentEditCodecFactory(deps.codec);

  async function documentFormat(
    documentId: DocumentId,
  ): Promise<Result<{ schemaType: YjsTrackedSchemaType; filetype: string | null }, SyncError>> {
    const filetype = (await deps.resolveFiletype?.(documentId)) ?? null;
    const classification = classifyFiletype(filetype);
    if (classification.kind === "tracked")
      return Ok({ filetype, schemaType: classification.schemaType });
    if (classification.kind === "unknown") return Ok({ filetype, schemaType: "document" });
    return Err({
      code: "corrupt_state",
      documentId,
      message: `Tracked document has registered ${classification.kind} filetype: ${filetype}`,
    });
  }

  function serializeForSchema(
    documentId: DocumentId,
    doc: Y.Doc,
    schemaType: YjsTrackedSchemaType,
    links: DocumentLinkScope,
  ): string {
    return projectBlocks(documentId, doc, (blocks) => {
      if (blocks.length === 0) return "";
      if (schemaType === "code") return blocks[0]?.textContent ?? "";
      return deps.codec.serialize(blocks, links);
    });
  }

  /**
   * Load what `docs` (and `stored` nodes: a bound write's) name, then spell
   * as this document in `view` (default live).
   */
  async function spelling(
    documentId: DocumentId,
    docs: readonly Y.Doc[],
    view: LinkView = LIVE_VIEW,
    stored: ParsedContent["blocks"] = [],
  ): Promise<HolderLinkScope> {
    await deps.links.prepare({ holders: [{ documentId, view }], docs, stored });
    return deps.links.holder({ documentId, view });
  }

  /**
   * Projection cannot mutate its input, by construction: it always runs against
   * a private clone, and `read` sees the blocks before that clone is destroyed.
   */
  function projectBlocks<T>(
    documentId: DocumentId,
    doc: Y.Doc,
    read: (blocks: ParsedContent["blocks"]) => T,
  ): T {
    const state = Y.encodeStateAsUpdate(doc);
    const nodeSpans = xmlNodeSpans(state);
    const clone = createCollabYDoc({ gc: false });
    Y.applyUpdate(clone, state);
    // y-prosemirror has identity-sensitive repairs. Restore the source client
    // after applying state so the clone projects exactly as the source would.
    clone.clientID = doc.clientID;
    const repairUpdates: Uint8Array[] = [];
    const observeRepair = (update: Uint8Array) => repairUpdates.push(update);
    clone.on("update", observeRepair);

    try {
      return read(deps.model.projectBlocks(toDocHandle(clone)).map((block) => block.node));
    } finally {
      clone.off("update", observeRepair);
      const anomaly = serializationAnomaly(repairUpdates, nodeSpans);
      clone.destroy();
      if (anomaly) {
        deps.observeSerializationAnomaly?.({
          documentId,
          schemaVersion: COLLAB_SCHEMA_VERSION,
          ...anomaly,
        });
      }
    }
  }

  /** A bound write for this holder, of the shape this document stores (one code block for code files). */
  function checkBound(
    documentId: DocumentId,
    content: BoundWrite,
    format: { schemaType: YjsTrackedSchemaType },
    use: HolderUse,
  ): Result<BoundWrite, SyncError> {
    assertHolder(documentId, content, use);
    if (content.schemaType !== format.schemaType) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: `Content bound as ${content.schemaType} for a ${format.schemaType} document`,
      });
    }
    return Ok(content);
  }

  /**
   * Overwrite `draft`, a copy of the live document taken under its lock, with
   * the bound nodes: agent-edit's whole-document correspondence, so blocks
   * left as they were keep their items. A writer's save outside a thread
   * carries no certified facts.
   */
  async function overwriteDraft(
    documentId: DocumentId,
    draft: Y.Doc,
    content: BoundWrite,
    yjsOrigin: TransactionOrigin,
  ): Promise<Result<void, SyncError>> {
    if (content.fresh && deps.model.getBlocks(toDocHandle(draft)).length > 0) {
      return Err({ code: "stale_generation", documentId });
    }
    const links = await spelling(documentId, [draft], LIVE_VIEW, [...content.blocks]);
    const written = overwriteWithAssigned({
      doc: draft,
      model: deps.model,
      codec: agentEditCodecs.forScope(links),
      documentId,
      content: content.markdown,
      blocks: content.blocks,
      origin: yjsOrigin,
    });
    if (!written.ok) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: `${written.code}: ${written.message}`,
      });
    }
    return Ok(undefined);
  }

  /**
   * Stage `mutate` on a copy of the live document, serialize, then admit it to the
   * journal and apply it to `liveDoc` once the caller's transaction commits (at once outside
   * one). `hook` says when `afterWrite` runs: `now` (the caller runs it), or `after-commit`
   * with the apply, for a held write that an abort must leave unprojected.
   */
  async function replaceLiveDocumentMarkdown(
    documentId: DocumentId,
    liveDoc: Y.Doc,
    mutate: DraftMutation,
    origin: RuntimeOrigin,
    schemaType: YjsTrackedSchemaType,
    hook: WriteHook = { kind: "now" },
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    // This copy stages the change so serialization and journal admission
    // both complete before the live document is mutated.
    const draft = createCollabYDoc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(liveDoc));
    const beforeVector = Y.encodeStateVector(draft);
    const yjsOrigin = yjsTransactionOrigin(origin);
    const mutated = await mutate(draft, yjsOrigin);
    if (!mutated.ok) {
      draft.destroy();
      return mutated;
    }
    const update = Y.encodeStateAsUpdate(draft, beforeVector);
    const links = await spelling(documentId, [draft]);
    // Serialize before admission: content the codec can't spell must fail
    // while the journal and live document are still untouched.
    const markdown = serializeForSchema(documentId, draft, schemaType, links);
    const meta = deps.metaForOrigin(origin);
    let seq = 0;
    await admitFreshAuthorship(
      {
        readMutationTarget: () => ({
          documentId,
          generation: documentAuthority(liveDoc).generation,
          doc: liveDoc,
        }),
        admitImmediate: async ({ update: admittedUpdate }) => {
          seq = await deps.journal.append(
            documentId,
            admittedUpdate,
            meta,
            documentAuthority(liveDoc),
          );
          // Inside a transaction `liveDoc` takes the row only once the root commits, never
          // before (LOCK-WS): a door acquired in the transaction handed out a private copy, and
          // one acquired before it (a held write) handed out the open room itself, whose
          // holder keeps the mutex through the commit so `deliver` couldn't run here.
          const apply = async () => {
            Y.applyUpdate(liveDoc, admittedUpdate, yjsOrigin);
            if (hook.kind === "after-commit")
              await deps.afterWrite?.({ documentId, threadId: hook.threadId, markdown });
          };
          if (!deps.deferUntilCommit?.(apply)) await apply();
          return { sequence: BigInt(seq) };
        },
      },
      { source: authorshipSource(origin), update },
    );
    return Ok({
      documentId,
      markdown,
      updateSeq: seq,
      updateData: update,
      meta: { ...meta, seq },
    });
  }

  async function setMarkdown(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const resolvedFormat = await documentFormat(input.documentId);
    if (!resolvedFormat.ok) return resolvedFormat;
    const format = resolvedFormat.value;
    const content = checkBound(input.documentId, input.content, format, "write");
    if (!content.ok) return content;
    return changeDocument(
      input,
      (draft, yjsOrigin) => overwriteDraft(input.documentId, draft, content.value, yjsOrigin),
      format,
    );
  }

  async function changeDocument(
    input: { documentId: DocumentId; origin: RuntimeOrigin; threadId?: ThreadId },
    mutate: DraftMutation,
    format: { schemaType: YjsTrackedSchemaType },
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    try {
      await ensureDocumentAuthority(input.documentId);
      const result = await deps.coordinator.withDocument(input.documentId, (liveDoc) =>
        replaceLiveDocumentMarkdown(
          input.documentId,
          liveDoc,
          mutate,
          input.origin,
          format.schemaType,
        ),
      );
      if (result.ok) {
        await deps.afterWrite?.({
          documentId: result.value.documentId,
          threadId: input.threadId,
          markdown: result.value.markdown,
        });
      }
      return result;
    } catch (cause) {
      if (isDocumentNotFoundError(cause)) {
        return Err({ code: "not_found", documentId: input.documentId });
      }
      throw cause;
    }
  }

  /**
   * Seeds an empty document when none has state, else does nothing; the unlocked read skips
   * the write transaction for the common case. Nothing else holds the text: it is an empty
   * document, not the empty paragraph a parse would give. Rooms recover after the boundary
   * that makes the state durable.
   */
  async function ensureDocumentAuthority(documentId: DocumentId): Promise<void> {
    if (!(await deps.initialDocumentSeeds.lacksAuthority(documentId))) return;
    const doc = createCollabYDoc({ gc: false });
    try {
      const seeded = await deps.initialDocumentSeeds.seedInitialDocument(
        documentId,
        Y.encodeStateAsUpdate(doc),
      );
      if (!seeded) return;
    } finally {
      doc.destroy();
    }
    const deliver = () => deps.coordinator.deliver(documentId);
    if (!deps.deferUntilCommit?.(deliver)) await deliver();
  }

  const engine: MarkdownDocumentEngine = {
    async serializeDocument(documentId, doc, view) {
      const format = await documentFormat(documentId);
      if (!format.ok) throwSyncError(format.error);
      const links = await spelling(documentId, [doc], view);
      return serializeForSchema(documentId, doc, format.value.schemaType, links);
    },

    async readFrozenMarkdown(documentId) {
      const snapshot = await deps.journal.read(documentId);
      if (!snapshot.checkpoint && snapshot.updates.length === 0) return "";
      const doc = storedDocument(snapshot);
      try {
        return await engine.serializeDocument(documentId, doc, LIVE_VIEW);
      } finally {
        doc.destroy();
      }
    },

    async serializeVersionedDocument(documentId, doc, view) {
      const format = await documentFormat(documentId);
      if (!format.ok) throwSyncError(format.error);
      const links = await spelling(documentId, [doc], view);
      return versioned(doc, links, (doc) =>
        serializeForSchema(documentId, doc, format.value.schemaType, links),
      );
    },

    async restoreFromYDoc(documentId, snapshot, origin) {
      const format = await documentFormat(documentId);
      if (!format.ok) return format;
      // Restore the snapshot's nodes as projected: a Markdown round trip would
      // drop every attribute the codec does not spell.
      const blocks = projectBlocks(documentId, snapshot, (blocks) => blocks);
      // Restore runs under the document's lock against what it holds now: a
      // whole replacement, not a bound write.
      return changeDocument(
        { documentId, origin },
        (draft, yjsOrigin) => {
          draft.transact(() => {
            const fragment = fragmentOf(draft);
            if (fragment.length > 0) fragment.delete(0, fragment.length);
            deps.model.insertBlocks(toDocHandle(draft), null, { blocks });
          }, yjsOrigin);
          return Ok(undefined);
        },
        format.value,
      );
    },

    async readAsMarkdown(documentId) {
      const read = await engine.readVersionedMarkdown(documentId);
      return read.ok ? Ok(read.value.content) : read;
    },

    async readVersionedMarkdown(documentId) {
      try {
        const format = await documentFormat(documentId as DocumentId);
        if (!format.ok) return format;
        const markdown = await deps.coordinator.withDocument(documentId, async (doc) => {
          const links = await spelling(documentId as DocumentId, [doc]);
          return versioned(doc, links, (doc) =>
            serializeForSchema(documentId as DocumentId, doc, format.value.schemaType, links),
          );
        });
        return Ok(markdown);
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
        throw cause;
      }
    },

    setMarkdown,

    ensureDocumentAuthority,

    async seedFromMarkdown(documentId, content, origin) {
      const typedDocumentId = documentId as DocumentId;
      const format = await documentFormat(typedDocumentId);
      if (!format.ok) return format;
      const bound = checkBound(typedDocumentId, content, format.value, "seed");
      if (!bound.ok) return bound;
      if (!bound.value.fresh) {
        throw new Error("A seed takes a fresh write; this one was bound against a document");
      }
      const seededDoc = createCollabYDoc({ gc: false });
      seededDoc.transact(() => {
        deps.model.insertBlocks(toDocHandle(seededDoc), null, { blocks: [...bound.value.blocks] });
      }, yjsTransactionOrigin(origin));
      const canonicalMarkdown = serializeForSchema(
        typedDocumentId,
        seededDoc,
        format.value.schemaType,
        await spelling(typedDocumentId, [seededDoc]),
      );
      const seeded = await deps.initialDocumentSeeds.seedInitialDocument(
        typedDocumentId,
        Y.encodeStateAsUpdate(seededDoc),
      );
      const deliver = () => deps.coordinator.deliver(typedDocumentId);
      // An enclosing aggregate may still roll back after the checkpoint is
      // written. Deliver to the rooms only after that durable boundary.
      if (!deps.deferUntilCommit?.(deliver)) await deliver();
      if (seeded) {
        await deps.afterWrite?.({ documentId: typedDocumentId, markdown: canonicalMarkdown });
      }
      return Ok(null);
    },

    async writeDocument(input) {
      const result = await identityPreservingSet(input);
      if (!result.ok) throwSyncError(result.error);
      return documentWriteResult(result.value, input.origin);
    },

    async withLiveDocument(documentId, operation) {
      await ensureDocumentAuthority(documentId as DocumentId);
      return deps.coordinator.withDocument(documentId, (doc) =>
        operation({ documentId: documentId as DocumentId, doc }),
      );
    },

    writeDocumentHeld,
  };
  return engine;

  /**
   * A revealed document's first content (§6.3 B3): the ordinary whole-document overwrite,
   * applied under the caller's held lease, accepting only creation-bound content for the
   * expected address, journaled in the caller's transaction and delivered to the open room after commit.
   */
  async function writeDocumentHeld(input: {
    held: HeldLiveDocument;
    content: BoundWrite;
    expected: HeldWriteExpectation;
    origin: DocumentWriteOrigin | DocumentSeedOrigin;
    threadId?: ThreadId;
  }): Promise<Result<HeldWriteStaged, SyncError>> {
    const { held } = input;
    const format = await documentFormat(held.documentId);
    if (!format.ok) return format;
    const content = checkBound(held.documentId, input.content, format.value, {
      reveal: input.expected,
    });
    if (!content.ok) return content;
    const written = await replaceLiveDocumentMarkdown(
      held.documentId,
      held.doc,
      (draft, yjsOrigin) => overwriteDraft(held.documentId, draft, content.value, yjsOrigin),
      input.origin,
      format.value.schemaType,
      { kind: "after-commit", threadId: input.threadId },
    );
    return written.ok
      ? Ok({ markdown: written.value.markdown, updateSeq: written.value.updateSeq })
      : written;
  }

  async function identityPreservingSet(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const format = await documentFormat(input.documentId);
    if (!format.ok) return format;
    if (input.origin.type === "user" && !input.threadId) return setMarkdown(input);
    const shaped = checkBound(input.documentId, input.content, format.value, "write");
    if (!shaped.ok) return shaped;
    await ensureDocumentAuthority(input.documentId);
    const actor = mutationActor(input.origin, input.threadId);
    const outcome = await deps.identityPreservingWrite({
      documentId: input.documentId,
      content: input.content,
      actor,
    });
    if (outcome.status !== "success") throw new DocumentMutationRejectedError(outcome);
    // Inside the caller's transaction the door reads a private copy holding this transaction's
    // rows, the save's own state; the open room takes them only once the root commits.
    const markdown = await deps.coordinator.withDocument(input.documentId, async (doc) =>
      serializeForSchema(
        input.documentId,
        doc,
        format.value.schemaType,
        await spelling(input.documentId, [doc]),
      ),
    );
    const snapshot = await deps.journal.read(input.documentId);
    const latest = snapshot.updates.at(-1);
    await deps.afterWrite?.({ documentId: input.documentId, threadId: input.threadId, markdown });
    return Ok({
      documentId: input.documentId,
      markdown,
      updateSeq: latest?.seq ?? 0,
      updateData: latest?.update ?? new Uint8Array(),
      meta: latest?.meta ?? deps.metaForOrigin(input.origin),
    });
  }
}

type ClockRange = {
  client: number;
  clockFrom: number;
  clockTo: number;
};

type XmlNodeSpan = ClockRange & {
  nodeType: string;
};

function xmlNodeSpans(update: Uint8Array): XmlNodeSpan[] {
  return Y.decodeUpdate(update).structs.flatMap((struct) => {
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) return [];
    const node = struct.content.type;
    if (!(node instanceof Y.XmlElement)) return [];
    return [
      {
        client: struct.id.client,
        clockFrom: struct.id.clock,
        clockTo: struct.id.clock + struct.length,
        nodeType: node.nodeName,
      },
    ];
  });
}

function serializationAnomaly(
  updates: Uint8Array[],
  nodeSpans: XmlNodeSpan[],
): { deletedNodeTypes: string[]; deletedClockCount: number } | null {
  if (updates.length === 0) return null;
  const ranges = mergeClockRanges(
    updates.flatMap((update) =>
      Array.from(Y.decodeUpdate(update).ds.clients, ([client, clientRanges]) =>
        clientRanges.map(({ clock, len }) => ({
          client,
          clockFrom: clock,
          clockTo: clock + len,
        })),
      ).flat(),
    ),
  );
  const deletedNodeTypes = new Set<string>();
  for (const node of nodeSpans) {
    if (
      ranges.some(
        (range) =>
          range.client === node.client &&
          range.clockFrom < node.clockTo &&
          node.clockFrom < range.clockTo,
      )
    ) {
      deletedNodeTypes.add(node.nodeType);
    }
  }
  return {
    deletedNodeTypes: [...deletedNodeTypes].sort(),
    deletedClockCount: ranges.reduce((count, range) => count + range.clockTo - range.clockFrom, 0),
  };
}

function mergeClockRanges(ranges: ClockRange[]): ClockRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.client - right.client || left.clockFrom - right.clockFrom,
  );
  const merged: ClockRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous !== undefined &&
      previous.client === range.client &&
      range.clockFrom <= previous.clockTo
    ) {
      previous.clockTo = Math.max(previous.clockTo, range.clockTo);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function authorshipSource(origin: RuntimeOrigin): AuthorshipSource {
  if (origin.type === "user") return { kind: "writer" };
  if (origin.type === "import") return { kind: "import", policy: "writer_protected" };
  return { kind: "seed", policy: origin.type === "agent" ? "agent" : "writer_protected" };
}

/**
 * How a bound write may be applied: `write` to the document it was bound for; `seed` to
 * that document, to the document being created (its creator checks the address) or as
 * fixed static content; `reveal` only creation-bound content for exactly the expected
 * address, onto exactly the expected (revealed) document (contract §6.3 B3).
 */
type HolderUse = "seed" | "write" | { reveal: HeldWriteExpectation };

/** A bound write certifies one holder; applying it to another document is a bug. */
function assertHolder(documentId: DocumentId, content: BoundWrite, use: HolderUse): void {
  const { holder } = content;
  if (typeof use === "object") {
    if (
      documentId !== use.reveal.documentId ||
      holder.kind !== "new" ||
      holder.uri !== use.reveal.uri
    ) {
      throw new Error(`Content bound for another holder cannot become ${use.reveal.uri}`);
    }
    return;
  }
  if (holder.kind === "document" ? holder.documentId !== documentId : use === "write") {
    throw new Error(
      `Content bound for ${holder.kind === "document" ? holder.documentId : holder.kind} cannot be applied to ${documentId}`,
    );
  }
}

export class DocumentMutationRejectedError extends Error {
  readonly status: WriteOutcome["status"];

  constructor(outcome: WriteOutcome) {
    super(renderAgentEditResult(outcome.result));
    this.name = "DocumentMutationRejectedError";
    this.status = outcome.status;
  }
}

function mutationActor(origin: DocumentWriteOrigin, threadId?: ThreadId): MutationActor {
  if (origin.type === "user") {
    return {
      kind: "human",
      userId: origin.actorUserId,
      ...(threadId ? { threadId } : {}),
    };
  }
  if (!threadId) throw new Error("Agent document writes require a threadId");
  return {
    kind: "agent",
    turnId: origin.actorTurnId,
    threadId,
    responseId: origin.actorTurnId,
  };
}

export function syncErrorMessage(error: SyncError): string {
  switch (error.code) {
    case "not_found":
      return `Document not found: ${error.documentId}`;
    case "stale_generation":
      return `Document generation changed: ${error.documentId}`;
    case "checkpoint_not_found":
      return `Checkpoint not found: ${error.checkpointId}`;
    case "corrupt_state":
      return error.message;
  }
}

export class DocumentSyncError extends Error {
  readonly code: SyncError["code"];

  constructor(readonly syncError: SyncError) {
    super(syncErrorMessage(syncError));
    this.name = "DocumentSyncError";
    this.code = syncError.code;
  }
}

function throwSyncError(error: SyncError): never {
  throw new DocumentSyncError(error);
}

function documentWriteResult(
  result: MarkdownSetResult,
  origin: DocumentWriteOrigin,
): DocumentWriteResult {
  return {
    documentId: result.documentId,
    markdown: result.markdown,
    updateSeq: result.updateSeq,
    updateData: Buffer.from(result.updateData),
    originType: origin.type,
    actorTurnId: origin.type === "agent" ? origin.actorTurnId : null,
    actorUserId: origin.type === "user" ? origin.actorUserId : null,
  };
}

function yjsTransactionOrigin(origin: RuntimeOrigin): TransactionOrigin {
  return { source: "local", context: { origin } };
}
