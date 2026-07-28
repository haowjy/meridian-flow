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
  toDocHandle,
  type UpdateJournal,
  type UpdateMeta,
  type WriteOutcome,
  type YProsemirrorDocumentModel,
} from "@meridian/agent-edit/integration";
import { classifyFiletype, type YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type { MarkupCodec, ParsedContent } from "@meridian/markup";
import { COLLAB_SCHEMA_VERSION, createCollabYDoc } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
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
import { type AuthorshipSource, admitFreshAuthorship } from "./document-mutation-policy.js";
import type { InitialDocumentSeeds } from "./ports/initial-document-seeds.js";

export type RuntimeOrigin = UpdateOrigin | DocumentWriteOrigin;

export type MarkdownSetResult = {
  documentId: DocumentId;
  markdown: string;
  updateSeq: number;
  updateData: Uint8Array;
  meta: UpdateMeta;
};

export type MarkdownEditResult = MarkdownSetResult & { beforeMarkdown: string };

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
  schema: Schema;
  model: YProsemirrorDocumentModel;
  journal: UpdateJournal;
  coordinator: DocumentCoordinator;
  lifecycle: Pick<DocumentLifecycle, "ensureDocument">;
  initialDocumentSeeds: InitialDocumentSeeds;
  metaForOrigin(origin: RuntimeOrigin): UpdateMeta;
  deferUntilCommit?(callback: () => void | Promise<void>): boolean;
  afterWrite?: MarkdownWriteHook;
  identityPreservingWrite?(input: {
    documentId: DocumentId;
    markdown: string;
    actor: MutationActor;
  }): Promise<WriteOutcome>;
  resolveFiletype?(documentId: DocumentId): Promise<string | null>;
  observeSerializationAnomaly?: MarkdownSerializationAnomalyObserver;
};

export type MarkdownDocumentEngine = {
  serializeDocument(documentId: DocumentId, doc: Y.Doc): Promise<string>;
  restoreFromYDoc(
    documentId: DocumentId,
    snapshot: Y.Doc,
    origin: RuntimeOrigin,
  ): Promise<Result<MarkdownSetResult, SyncError>>;
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  setMarkdown(input: {
    documentId: DocumentId;
    markdown: string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>>;
  editMarkdown(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownEditResult, SyncError>>;
  seedFromMarkdown(
    documentId: string,
    markdown: string,
    origin: DocumentSeedOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>>;
  writeDocument(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  editDocument(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult & { beforeMarkdown: string }>;
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

  /**
   * The serializer cannot mutate its input, by construction: schema projection
   * always runs against a private clone.
   */
  function serializeForSchema(
    documentId: DocumentId,
    doc: Y.Doc,
    schemaType: YjsTrackedSchemaType,
  ): string {
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
      const blocks = deps.model.projectBlocks(toDocHandle(clone));
      if (blocks.length === 0) return "";
      if (schemaType === "code") return blocks[0]?.textContent ?? "";
      return deps.codec.serialize(blocks);
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

  function parseMarkdown(
    documentId: DocumentId,
    markdown: string,
    format: { schemaType: YjsTrackedSchemaType; filetype: string | null },
  ): Result<ParsedContent, SyncError> {
    try {
      if (format.schemaType === "code") {
        const content = markdown.length > 0 ? deps.schema.text(markdown) : undefined;
        return Ok({
          blocks: [deps.schema.nodes.code_block.create({ language: format.filetype }, content)],
        });
      }
      return Ok(deps.codec.parse(markdown));
    } catch (cause) {
      return Err({
        code: "corrupt_state",
        documentId,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  async function replaceLiveDocumentMarkdown(
    documentId: DocumentId,
    liveDoc: Y.Doc,
    parsed: ParsedContent,
    origin: RuntimeOrigin,
    schemaType: YjsTrackedSchemaType,
  ): Promise<Result<MarkdownSetResult, SyncError>> {
    // This copy stages the replacement update so journal admission completes
    // before the live document is mutated; it is not a serialization guard.
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
    const meta = deps.metaForOrigin(origin);
    let seq = 0;
    await admitFreshAuthorship(
      {
        readMutationTarget: () => ({ documentId, generation: 0n, doc: liveDoc }),
        admitImmediate: async ({ update: admittedUpdate }) => {
          seq = await deps.journal.append(documentId, admittedUpdate, meta);
          Y.applyUpdate(liveDoc, admittedUpdate, yjsOrigin);
          return { sequence: BigInt(seq), joined: 0 };
        },
      },
      { source: authorshipSource(origin), update },
    );
    return Ok({
      documentId,
      markdown: serializeForSchema(documentId, draft, schemaType),
      updateSeq: seq,
      updateData: update,
      meta: { ...meta, seq },
    });
  }

  async function setMarkdown(input: {
    documentId: DocumentId;
    markdown: string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const resolvedFormat = await documentFormat(input.documentId);
    if (!resolvedFormat.ok) return resolvedFormat;
    const format = resolvedFormat.value;
    const parsed = parseMarkdown(input.documentId, input.markdown, format);
    if (!parsed.ok) return parsed;

    await deps.lifecycle.ensureDocument(input.documentId);

    try {
      const result = await deps.coordinator.withDocument(input.documentId, (liveDoc) =>
        replaceLiveDocumentMarkdown(
          input.documentId,
          liveDoc,
          parsed.value,
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

  async function editMarkdown(input: {
    documentId: DocumentId;
    transform: (markdown: string) => string;
    origin: RuntimeOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownEditResult, SyncError>> {
    await deps.lifecycle.ensureDocument(input.documentId);
    const resolvedFormat = await documentFormat(input.documentId);
    if (!resolvedFormat.ok) return resolvedFormat;
    const format = resolvedFormat.value;

    try {
      const result = await deps.coordinator.withDocument(input.documentId, async (liveDoc) => {
        const beforeMarkdown = serializeForSchema(input.documentId, liveDoc, format.schemaType);
        const parsed = parseMarkdown(input.documentId, input.transform(beforeMarkdown), format);
        if (!parsed.ok) return parsed;

        const result = await replaceLiveDocumentMarkdown(
          input.documentId,
          liveDoc,
          parsed.value,
          input.origin,
          format.schemaType,
        );
        return result.ok ? Ok({ ...result.value, beforeMarkdown }) : result;
      });
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

  return {
    async serializeDocument(documentId, doc) {
      const format = await documentFormat(documentId);
      if (!format.ok) throwSyncError(format.error);
      return serializeForSchema(documentId, doc, format.value.schemaType);
    },

    async restoreFromYDoc(documentId, snapshot, origin) {
      const format = await documentFormat(documentId);
      if (!format.ok) return format;
      return setMarkdown({
        documentId,
        markdown: serializeForSchema(documentId, snapshot, format.value.schemaType),
        origin,
      });
    },

    async readAsMarkdown(documentId) {
      try {
        const format = await documentFormat(documentId as DocumentId);
        if (!format.ok) return format;
        const markdown = await deps.coordinator.withDocument(documentId, async (doc) =>
          serializeForSchema(documentId as DocumentId, doc, format.value.schemaType),
        );
        return Ok(markdown);
      } catch (cause) {
        if (isDocumentNotFoundError(cause)) return Err({ code: "not_found", documentId });
        throw cause;
      }
    },

    setMarkdown,

    editMarkdown,

    async seedFromMarkdown(documentId, markdown, origin) {
      const typedDocumentId = documentId as DocumentId;
      const format = await documentFormat(typedDocumentId);
      if (!format.ok) return format;
      const parsed = parseMarkdown(typedDocumentId, markdown, format.value);
      if (!parsed.ok) return parsed;
      const seededDoc = createCollabYDoc({ gc: false });
      seededDoc.transact(() => {
        deps.model.insertBlocks(toDocHandle(seededDoc), null, parsed.value);
      }, yjsTransactionOrigin(origin));
      const canonicalMarkdown = serializeForSchema(
        typedDocumentId,
        seededDoc,
        format.value.schemaType,
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

    async editDocument(input) {
      const format = await documentFormat(input.documentId);
      if (!format.ok) throwSyncError(format.error);
      const beforeMarkdown = await deps.coordinator.withDocument(input.documentId, async (doc) =>
        serializeForSchema(input.documentId, doc, format.value.schemaType),
      );
      const result = await identityPreservingSet({
        ...input,
        markdown: input.transform(beforeMarkdown),
      });
      if (!result.ok) throwSyncError(result.error);
      return {
        ...documentWriteResult(result.value, input.origin),
        beforeMarkdown,
      };
    },
  };

  async function identityPreservingSet(input: {
    documentId: DocumentId;
    markdown: string;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<Result<MarkdownSetResult, SyncError>> {
    const format = await documentFormat(input.documentId);
    if (!format.ok) return format;
    if (input.origin.type === "user" && !input.threadId) return setMarkdown(input);
    const actor = mutationActor(input.origin, input.threadId);
    if (!deps.identityPreservingWrite) {
      throw new Error("Identity-preserving document writes are not configured");
    }
    const outcome = await deps.identityPreservingWrite({
      documentId: input.documentId,
      markdown: identityPreservingContent(input.markdown, format.value),
      actor,
    });
    if (outcome.status !== "success") throw new DocumentMutationRejectedError(outcome);
    const markdown = await deps.coordinator.withDocument(input.documentId, async (doc) =>
      serializeForSchema(input.documentId, doc, format.value.schemaType),
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

function identityPreservingContent(
  markdown: string,
  format: { schemaType: YjsTrackedSchemaType; filetype: string | null },
): string {
  if (format.schemaType !== "code") return markdown;
  const longestFence = Math.max(0, ...Array.from(markdown.matchAll(/`+/g), ([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${format.filetype ?? ""}\n${markdown}${markdown.endsWith("\n") ? "" : "\n"}${fence}`;
}

export class DocumentMutationRejectedError extends Error {
  readonly status: WriteOutcome["status"];

  constructor(outcome: WriteOutcome) {
    super(outcome.text);
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
