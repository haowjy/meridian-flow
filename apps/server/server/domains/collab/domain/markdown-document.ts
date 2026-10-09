/**
 * Server-side full-document markdown SET/read engine for collab documents.
 *
 * This intentionally stays out of `@meridian/agent-edit`: full-document SET is a
 * Meridian server persistence/read-model concern, built only by orchestrating the
 * package codec/model, Yjs fragment helper, journal, and document coordinator.
 */
import type { TransactionOrigin } from "@hocuspocus/server";
import {
  type DocumentCoordinator,
  type DocumentLifecycle,
  fragmentOf,
  isDocumentNotFoundError,
  type MutationActor,
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
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "../contracts.js";
import { documentAuthority } from "./document-handle.js";
import { type AuthorshipSource, admitFreshAuthorship } from "./document-mutation-policy.js";
import { versioned } from "./document-revision.js";
import type { BoundContent } from "./link-binding.js";
import {
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";
import type { InitialDocumentSeeds } from "./ports/initial-document-seeds.js";

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
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  initialDocumentSeeds: InitialDocumentSeeds;
  metaForOrigin(origin: RuntimeOrigin): UpdateMeta;
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  afterWrite?: MarkdownWriteHook;
  /** The whole-document create-overwrite, applying nodes already bound (assignment skipped). */
  identityPreservingWrite(input: {
    documentId: DocumentId;
    content: BoundContent;
    actor: MutationActor;
  }): Promise<WriteOutcome>;
  resolveFiletype?(documentId: DocumentId): Promise<string | null>;
  observeSerializationAnomaly?: MarkdownSerializationAnomalyObserver;
};

export type MarkdownDocumentEngine = {
  /** `view` is the version `doc` is: a Work draft's links spell in that draft. */
  serializeDocument(documentId: DocumentId, doc: Y.Doc, view: LinkView): Promise<string>;
  /** `view` is the version `doc` is: a Work draft's links spell in that draft. */
  serializeVersionedDocument(
    documentId: DocumentId,
    doc: Y.Doc,
    view: LinkView,
  ): Promise<{ content: string; revision: string }>;
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
   * Whole-document writes take content a `LinkBinder` bound before the
   * caller's transaction (contract §6.2); none of them parses Markdown.
   */
  setMarkdown(input: {
    documentId: DocumentId;
    content: BoundContent;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>>;
  /** Writes only a document with no state yet; otherwise a no-op. */
  seedFromMarkdown(
    documentId: string,
    content: BoundContent,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    content: BoundContent;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
};

export function createMarkdownDocumentEngine(
  deps: MarkdownDocumentEngineDeps,
): MarkdownDocumentEngine {
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

  /** Load what `docs` name, then spell as this document in `view` (default live). */
  async function spelling(
    documentId: DocumentId,
    docs: readonly Y.Doc[],
    view: LinkView = LIVE_VIEW,
  ): Promise<HolderLinkScope> {
    await deps.links.prepare({ holders: [{ documentId, view }], docs });
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
      return read(deps.model.projectBlocks(toDocHandle(clone)));
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

  /** Bound content of the shape this document stores (one code block for code files). */
  function contentFor(
    documentId: DocumentId,
    content: BoundContent,
    format: { schemaType: YjsTrackedSchemaType },
  ): Result<ParsedContent, SyncError> {
    if (content.schemaType !== format.schemaType) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: `Content bound as ${content.schemaType} for a ${format.schemaType} document`,
      });
    }
    return Ok({ blocks: [...content.blocks] });
  }

  async function replaceLiveDocumentMarkdown(
    documentId: DocumentId,
    liveDoc: Y.Doc,
    parsed: ParsedContent,
    origin: RuntimeOrigin,
    schemaType: YjsTrackedSchemaType,
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    // This copy stages the replacement so serialization and journal admission
    // both complete before the live document is mutated.
    const draft = createCollabYDoc({ gc: false });
    Y.applyUpdate(draft, Y.encodeStateAsUpdate(liveDoc));
    const beforeVector = Y.encodeStateVector(draft);
    const yjsOrigin = yjsTransactionOrigin(origin);
    draft.transact(() => {
      const fragment = fragmentOf(draft);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      deps.model.insertBlocks(toDocHandle(draft), null, parsed);
    }, yjsOrigin);
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
          Y.applyUpdate(liveDoc, admittedUpdate, yjsOrigin);
          return { sequence: BigInt(seq), joined: 0 };
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
    content: BoundContent;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const resolvedFormat = await documentFormat(input.documentId);
    if (!resolvedFormat.ok) return resolvedFormat;
    const format = resolvedFormat.value;
    const content = contentFor(input.documentId, input.content, format);
    if (!content.ok) return content;
    return replaceDocument(input, content.value, format);
  }

  async function replaceDocument(
    input: { documentId: DocumentId; origin: RuntimeOrigin; threadId?: ThreadId },
    content: ParsedContent,
    format: { schemaType: YjsTrackedSchemaType },
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    await deps.lifecycle.ensureDocument(input.documentId);

    try {
      const result = await deps.coordinator.withDocument(input.documentId, (liveDoc) =>
        replaceLiveDocumentMarkdown(
          input.documentId,
          liveDoc,
          content,
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

  const engine: MarkdownDocumentEngine = {
    async serializeDocument(documentId, doc, view) {
      const format = await documentFormat(documentId);
      if (!format.ok) throwSyncError(format.error);
      const links = await spelling(documentId, [doc], view);
      return serializeForSchema(documentId, doc, format.value.schemaType, links);
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
      return replaceDocument({ documentId, origin }, { blocks }, format.value);
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

    async seedFromMarkdown(documentId, content, origin) {
      const typedDocumentId = documentId as DocumentId;
      const format = await documentFormat(typedDocumentId);
      if (!format.ok) return format;
      const bound = contentFor(typedDocumentId, content, format.value);
      if (!bound.ok) return bound;
      const seededDoc = createCollabYDoc({ gc: false });
      seededDoc.transact(() => {
        deps.model.insertBlocks(toDocHandle(seededDoc), null, bound.value);
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
      const recover = () => deps.coordinator.recover(typedDocumentId);
      // An enclosing aggregate may still roll back after the checkpoint is
      // written. Publish only after that durable boundary.
      if (!deps.deferUntilCommit?.(recover)) await recover();
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
  };
  return engine;

  async function identityPreservingSet(input: {
    documentId: DocumentId;
    content: BoundContent;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const format = await documentFormat(input.documentId);
    if (!format.ok) return format;
    if (input.origin.type === "user" && !input.threadId) return setMarkdown(input);
    const shaped = contentFor(input.documentId, input.content, format.value);
    if (!shaped.ok) return shaped;
    const actor = mutationActor(input.origin, input.threadId);
    const outcome = await deps.identityPreservingWrite({
      documentId: input.documentId,
      content: input.content,
      actor,
    });
    if (outcome.status !== "success") throw new DocumentMutationRejectedError(outcome);
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
    const item = struct as typeof struct & {
      content?: { getContent?(): unknown[] };
    };
    const node = item.content?.getContent?.().find((value) => value instanceof Y.XmlElement);
    if (!(node instanceof Y.XmlElement)) return [];
    return [
      {
        client: item.id.client,
        clockFrom: item.id.clock,
        clockTo: item.id.clock + item.length,
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
