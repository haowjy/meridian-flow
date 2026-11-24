/**
 * The server's Markdown door to a document's text (design §4): every read, whole-document write,
 * seed and code merge outside the model's own tools goes through `DocumentRooms`, reading a copy
 * of the room and committing what changed on it as one batch.
 *
 * This stays out of `@meridian/agent-edit`: full-document SET is a server persistence concern,
 * built by orchestrating the package's codec and model with the room door.
 */

import {
  createAgentEditCodecFactory,
  LoroDocument,
  loroModel,
  overwriteWithAssigned,
  toLoroHandle,
} from "@meridian/agent-edit/integration";
import type { LinkView } from "@meridian/contracts";
import {
  classifyFiletype,
  type DocumentRoom,
  type TrackedSchemaType,
} from "@meridian/contracts/protocol";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import {
  encodeEnvelope,
  encodeRoomVersion,
  freshServerPeerId,
  RoomDocs,
  type WriteOptions,
} from "@meridian/document-model";
import type { DocumentRooms, RoomOrigin } from "@meridian/document-model/rooms";
import { shapeSchemaOf } from "@meridian/loro-prosemirror";
import type { DocumentLinkScope, MarkupCodec, PMNode } from "@meridian/markup";
import { isEmptyDocument } from "@meridian/prosemirror-schema";
import type { Schema } from "prosemirror-model";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  DocumentSeedOrigin,
  DocumentWriteOrigin,
  DocumentWriteResult,
  SyncError,
  UpdateOrigin,
} from "../contracts.js";
import { mergeCodeText } from "./code-merge.js";
import { cutRevision } from "./document-revision.js";
import type { BoundWrite } from "./link-binding.js";
import {
  type DocumentLinkScopes,
  type HolderLinkScope,
  LIVE_VIEW,
} from "./ports/document-link-scope.js";

type RuntimeOrigin = UpdateOrigin | DocumentWriteOrigin;

type MarkdownWriteHook = (event: { documentId: DocumentId; threadId?: ThreadId }) => Promise<void>;

type MarkdownDocumentEngineDeps<Tx> = {
  schema: Schema;
  codec: MarkupCodec;
  exportCodec: MarkupCodec;
  /**
   * The operation's document-link scope: each method prepares it with the
   * document it is about to spell, then serializes through the holder. The
   * scope doors (`document-link-scope-doors.ts`) open it.
   */
  links: DocumentLinkScopes;
  rooms: DocumentRooms<Tx>;
  /** Runs `work` in the caller's transaction, or in one of its own outside any. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** Takes the document's mutation lock in the open transaction, held to its end. */
  lockDocument(documentId: DocumentId): Promise<void>;
  afterWrite?: MarkdownWriteHook;
  resolveFiletype?(documentId: DocumentId): Promise<string | null>;
};

class MergeChangesNothing extends Error {}

/** A change made on a copy of the room: `doc` is the copy as the model reads and writes it. */
type DocumentChange = (doc: LoroDocument) => Promise<Result<void, SyncError>>;

export type MarkdownDocumentEngine = {
  /**
   * A copy of `room` as agent-edit's model reads it, for `read` to use and drop: it is freed when
   * `read` settles, so nothing may keep it.
   */
  readRoom<T>(room: DocumentRoom, read: (doc: LoroDocument) => Promise<T>): Promise<T>;
  /** The Live document's top-level blocks; null when no write has reached it yet. */
  currentBlocks(documentId: DocumentId): Promise<PMNode[] | null>;
  /** `view` is the version `doc` is: a Work draft's links spell in its draft's view. */
  serializeVersionedDocument(
    documentId: DocumentId,
    doc: LoroDocument,
    view: LinkView,
  ): Promise<{ content: string; revision: string }>;
  readVersionedMarkdown(
    documentId: string,
  ): Promise<Result<{ content: string; revision: string }, SyncError>>;
  readForExport(
    documentId: string,
    scope: (links: HolderLinkScope) => DocumentLinkScope,
  ): Promise<Result<string, SyncError>>;
  /** The markdown of the document's text, whatever its lifecycle; empty when it holds none. */
  readAsMarkdown(documentId: string): Promise<Result<string, SyncError>>;
  /** Writes only a document with no state yet; otherwise a no-op. Takes fresh writes only. */
  seedFromMarkdown(
    documentId: string,
    content: BoundWrite,
    origin: DocumentSeedOrigin,
  ): Promise<Result<void, SyncError>>;
  /**
   * The first state of fresh bound content (an envelope of snapshots), built in memory with no
   * database or room in reach: a bulk create encodes it before its transaction and installs it
   * inside.
   */
  encodeSeed(content: BoundWrite, origin: DocumentSeedOrigin): Uint8Array;
  /**
   * Installs the first states of documents the caller's transaction just created, from
   * `encodeSeed` (null for a document with no text, which needs no row). Rooms hear of it after
   * commit. It derives nothing: the caller refreshes the projections once its transaction commits.
   */
  installSeeds(
    seeds: readonly { documentId: DocumentId; state: Uint8Array | null }[],
  ): Promise<void>;
  /**
   * Whole-document writes take a write a `LinkBinder` bound before the caller's transaction
   * (contract §6.2); none of them parses Markdown. Each applies only to the holder it was bound
   * for, as the whole-document overwrite of what the document holds, aligned so the blocks it
   * leaves as they were keep their ids. A fresh write that finds content it never saw is
   * `stale_document`.
   */
  writeDocument(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: DocumentWriteOrigin;
    threadId?: ThreadId;
  }): Promise<DocumentWriteResult>;
  /** A document a Work created takes its content, written like a seed whatever it holds. */
  writeCreatedContent(input: {
    documentId: DocumentId;
    content: BoundWrite;
    origin: DocumentWriteOrigin;
  }): Promise<void>;
  mergeCodeText(input: {
    documentId: DocumentId;
    base: string;
    target: string;
    origin: DocumentWriteOrigin;
  }): Promise<Result<{ text: string; clashes: number; changed: boolean }, SyncError>>;
};

export function createMarkdownDocumentEngine<Tx>(
  deps: MarkdownDocumentEngineDeps<Tx>,
): MarkdownDocumentEngine {
  const agentEditCodecs = createAgentEditCodecFactory(deps.codec);
  const model = loroModel(deps.schema);
  const shape = shapeSchemaOf(deps.schema);
  const liveRoom = (documentId: string): DocumentRoom => ({
    kind: "live",
    documentId: documentId as DocumentId,
  });

  async function documentFormat(
    documentId: DocumentId,
  ): Promise<Result<{ schemaType: TrackedSchemaType; filetype: string | null }, SyncError>> {
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

  /** The document's top-level blocks as every reader sees them, without ids. */
  const blocksOf = (doc: LoroDocument): PMNode[] =>
    model.projectBlocks(toLoroHandle(doc)).map((block) => block.node);

  function serializeForSchema(
    blocks: readonly PMNode[],
    schemaType: TrackedSchemaType,
    links: DocumentLinkScope,
    codec: MarkupCodec = deps.codec,
  ): string {
    if (isEmptyDocument(blocks)) return "";
    if (schemaType === "code") return blocks[0]?.textContent ?? "";
    return codec.serialize([...blocks], links);
  }

  /**
   * Load what `blocks` (and `stored` nodes: a bound write's) name, then spell as this document in
   * `view` (default live).
   */
  async function spelling(
    documentId: DocumentId,
    blocks: readonly PMNode[],
    view: LinkView = LIVE_VIEW,
    stored: readonly PMNode[] = [],
  ): Promise<HolderLinkScope> {
    await deps.links.prepare({
      holders: [{ documentId, view }],
      stored: [...blocks, ...stored],
    });
    return deps.links.holder({ documentId, view });
  }

  async function readRoom<T>(
    room: DocumentRoom,
    read: (doc: LoroDocument) => Promise<T>,
  ): Promise<T> {
    const docs = await deps.rooms.read(room);
    try {
      return await read(new LoroDocument(docs, deps.schema));
    } finally {
      docs.free();
    }
  }

  async function versionedRead(
    documentId: DocumentId,
    doc: LoroDocument,
    view: LinkView,
    schemaType: TrackedSchemaType,
  ) {
    const blocks = blocksOf(doc);
    const links = await spelling(documentId, blocks, view);
    return {
      content: serializeForSchema(blocks, schemaType, links),
      revision: cutRevision({ version: encodeRoomVersion(doc.docs.shownVersion()), blocks }, links),
    };
  }

  /** A bound write for this holder, of the shape this document stores (one code block for code files). */
  function checkBound(
    documentId: DocumentId,
    content: BoundWrite,
    format: { schemaType: TrackedSchemaType },
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
   * Overwrite `doc` with the bound nodes: agent-edit's whole-document correspondence, so blocks
   * left as they were keep their ids.
   */
  async function overwrite(
    documentId: DocumentId,
    doc: LoroDocument,
    content: Pick<BoundWrite, "fresh" | "blocks" | "markdown">,
  ): Promise<Result<void, SyncError>> {
    const current = blocksOf(doc);
    if (content.fresh && !isEmptyDocument(current)) {
      return Err({ code: "stale_document", documentId });
    }
    const links = await spelling(documentId, current, LIVE_VIEW, content.blocks);
    const written = overwriteWithAssigned({
      doc: toLoroHandle(doc),
      model,
      codec: agentEditCodecs.forScope(links),
      documentId,
      content: content.markdown,
      blocks: content.blocks,
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
   * Make `change` on a copy of the Live room under the document's lock, and commit what it
   * changed as one batch in the caller's transaction (its own outside one): its snapshot rows are
   * written there, so the write survives a crash right after, and the room imports the batch
   * once it commits.
   */
  async function changeDocument(
    input: { documentId: DocumentId; origin: RuntimeOrigin; threadId?: ThreadId },
    change: DocumentChange,
    format: { schemaType: TrackedSchemaType },
  ): Promise<Result<{ markdown: string }, SyncError>> {
    const result = await deps.transaction(async (tx) => {
      await deps.lockDocument(input.documentId);
      const room = liveRoom(input.documentId);
      const docs = await deps.rooms.read(room);
      try {
        const before = docs.version();
        const doc = new LoroDocument(docs, deps.schema, writeOptionsOf(input.origin));
        const changed = await change(doc);
        if (!changed.ok) return changed;
        const update = docs.exportSince(before);
        if (update.size > 0)
          await deps.rooms.commit(tx, room, encodeEnvelope(update), roomOriginOf(input.origin));
        const blocks = blocksOf(doc);
        const links = await spelling(input.documentId, blocks);
        return Ok({ markdown: serializeForSchema(blocks, format.schemaType, links) });
      } finally {
        docs.free();
      }
    });
    if (result.ok)
      await deps.afterWrite?.({ documentId: input.documentId, threadId: input.threadId });
    return result;
  }

  async function readVersionedMarkdown(
    documentId: string,
  ): Promise<Result<{ content: string; revision: string }, SyncError>> {
    const id = documentId as DocumentId;
    const format = await documentFormat(id);
    if (!format.ok) return format;
    return Ok(
      await readRoom(liveRoom(id), (doc) =>
        versionedRead(id, doc, LIVE_VIEW, format.value.schemaType),
      ),
    );
  }

  /** A document with fresh bound content as its only state, as a seed's envelope of snapshots. */
  function seedOf(content: BoundWrite, origin: DocumentSeedOrigin): Uint8Array {
    const docs = RoomDocs.create(shape, freshServerPeerId());
    try {
      const doc = new LoroDocument(docs, deps.schema, writeOptionsOf(origin));
      if (content.blocks.length > 0)
        model.insertBlocks(toLoroHandle(doc), null, { blocks: [...content.blocks] });
      return encodeEnvelope(docs.snapshots());
    } finally {
      docs.free();
    }
  }

  return {
    readRoom,

    currentBlocks: (documentId) =>
      readRoom(liveRoom(documentId), async (doc) => (hasState(doc.docs) ? blocksOf(doc) : null)),

    async serializeVersionedDocument(documentId, doc, view) {
      const format = await documentFormat(documentId);
      if (!format.ok) throwSyncError(format.error);
      return versionedRead(documentId, doc, view, format.value.schemaType);
    },

    async readForExport(documentId, scope) {
      const id = documentId as DocumentId;
      const format = await documentFormat(id);
      if (!format.ok) return format;
      return Ok(
        await readRoom(liveRoom(id), async (doc) => {
          const blocks = blocksOf(doc);
          const links = await spelling(id, blocks);
          return serializeForSchema(
            blocks,
            format.value.schemaType,
            scope(links),
            deps.exportCodec,
          );
        }),
      );
    },

    async readAsMarkdown(documentId) {
      const read = await readVersionedMarkdown(documentId);
      return read.ok ? Ok(read.value.content) : read;
    },

    readVersionedMarkdown,

    async seedFromMarkdown(documentId, content, origin) {
      const id = documentId as DocumentId;
      const format = await documentFormat(id);
      if (!format.ok) return format;
      const bound = checkBound(id, content, format.value, "seed");
      if (!bound.ok) return bound;
      if (!bound.value.fresh) {
        throw new Error("A seed takes a fresh write; this one was bound against a document");
      }
      const seeded = await deps.transaction(async (tx) => {
        await deps.lockDocument(id);
        const room = liveRoom(id);
        const docs = await deps.rooms.read(room);
        const held = hasState(docs);
        docs.free();
        if (held) return false;
        await deps.rooms.seed(tx, room, seedOf(bound.value, origin));
        return true;
      });
      if (seeded) await deps.afterWrite?.({ documentId: id });
      return Ok(undefined);
    },

    encodeSeed: seedOf,

    async installSeeds(seeds) {
      const states = seeds.filter(
        (seed): seed is { documentId: DocumentId; state: Uint8Array } => seed.state !== null,
      );
      if (states.length === 0) return;
      await deps.transaction(async (tx) => {
        for (const { documentId, state } of states)
          await deps.rooms.seed(tx, liveRoom(documentId), state);
      });
    },

    async writeDocument(input) {
      const format = await documentFormat(input.documentId);
      if (!format.ok) throwSyncError(format.error);
      const content = checkBound(input.documentId, input.content, format.value, "write");
      if (!content.ok) throwSyncError(content.error);
      const written = await changeDocument(
        input,
        (doc) => overwrite(input.documentId, doc, content.value),
        format.value,
      );
      if (!written.ok) throwSyncError(written.error);
      const { origin } = input;
      return {
        documentId: input.documentId,
        markdown: written.value.markdown,
        originType: origin.type,
        actorTurnId: origin.type === "agent" ? origin.actorTurnId : null,
        actorUserId: origin.type === "user" ? origin.actorUserId : null,
      };
    },

    async writeCreatedContent(input) {
      const format = await documentFormat(input.documentId);
      if (!format.ok) throwSyncError(format.error);
      const written = await changeDocument(
        input,
        (doc) =>
          overwrite(input.documentId, doc, {
            fresh: false,
            blocks: input.content.blocks,
            markdown: input.content.markdown,
          }),
        format.value,
      );
      if (!written.ok) throwSyncError(written.error);
    },

    async mergeCodeText({ documentId, base, target, origin }) {
      const format = await documentFormat(documentId);
      if (!format.ok) return format;
      if (format.value.schemaType !== "code") {
        return Err({ code: "corrupt_state", documentId, message: "Not a code document" });
      }
      let result = { text: "", clashes: 0 };
      try {
        const written = await changeDocument(
          { documentId, origin },
          async (doc) => {
            const [block] = blocksOf(doc);
            const live = block?.textContent ?? "";
            result = mergeCodeText({ base, live, target });
            const merged = result.text;
            // Raised before anything is committed: nothing to write, nothing to announce.
            if (merged === live) throw new MergeChangesNothing();
            const next = block
              ? block.type.create(block.attrs, merged ? block.type.schema.text(merged) : undefined)
              : undefined;
            return overwrite(documentId, doc, {
              fresh: false,
              blocks: next ? [next] : [],
              markdown: merged,
            });
          },
          format.value,
        );
        return written.ok ? Ok({ ...result, changed: true }) : written;
      } catch (cause) {
        if (cause instanceof MergeChangesNothing) return Ok({ ...result, changed: false });
        throw cause;
      }
    },
  };
}

/** Whether a copy holds any state: a document no write has reached has no rows and no ops. */
function hasState(docs: RoomDocs): boolean {
  return [...docs.owned()].some(([, doc]) => doc.oplogFrontiers().length > 0);
}

/** An agent's write carries its turn as the commit message: who changed what reads it (design §5). */
function writeOptionsOf(origin: RuntimeOrigin): WriteOptions {
  return origin.type === "agent" ? { by: { turn: origin.actorTurnId } } : {};
}

function roomOriginOf(origin: RuntimeOrigin): RoomOrigin {
  return origin.type === "agent" ? `server:turn:${origin.actorTurnId}` : `server:${origin.type}`;
}

/**
 * How a bound write may be applied: `write` to the document it was bound for; `seed` to
 * that document, to the document being created (its creator checks the address) or as
 * fixed static content.
 */
type HolderUse = "seed" | "write";

/** A bound write certifies one holder; applying it to another document is a bug. */
function assertHolder(documentId: DocumentId, content: BoundWrite, use: HolderUse): void {
  const { holder } = content;
  if (holder.kind === "document" ? holder.documentId !== documentId : use === "write") {
    throw new Error(
      `Content bound for ${holder.kind === "document" ? holder.documentId : holder.kind} cannot be applied to ${documentId}`,
    );
  }
}

export function syncErrorMessage(error: SyncError): string {
  switch (error.code) {
    case "not_found":
      return `Document not found: ${error.documentId}`;
    case "stale_document":
      return `Document changed under the write: ${error.documentId}`;
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
