import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { DocumentStore, HeadRow } from "../ports/document-store.js";
import type {
  CheckpointInfo,
  DocumentSyncPort,
  PersistedUpdate,
  SyncError,
  UpdateOrigin,
} from "../ports/document-sync.js";
import {
  applyRemoteUpdate,
  cloneMirror,
  createMirror,
  encodeState,
  encodeStateVector,
  type MirrorEntry,
  markdownFromState,
  originColumns,
  readAsMarkdown,
  rebuildMirror,
  setDocumentToMarkdown,
  YjsDecodeError,
} from "./yjs-mirror.js";

export interface DocumentSyncServiceOptions {
  autoCheckpointEvery?: number;
  compaction?: false;
}

const DEFAULT_AUTO_CHECKPOINT_EVERY = 100;

export class DocumentSyncService implements DocumentSyncPort {
  private readonly store: DocumentStore;
  private readonly autoCheckpointEvery: number;
  private readonly cache = new Map<string, MirrorEntry>();
  private readonly mutex = new KeyedMutex();

  constructor(store: DocumentStore, options: DocumentSyncServiceOptions = {}) {
    this.store = store;
    this.autoCheckpointEvery = options.autoCheckpointEvery ?? DEFAULT_AUTO_CHECKPOINT_EVERY;
    if (options.compaction !== undefined && options.compaction !== false) {
      throw new Error("Meridian collab only supports compaction: false");
    }
  }

  async getOrCreateMirror(
    documentId: string,
    initialContent: string,
    filetype: string,
  ): Promise<Result<string, SyncError>> {
    return this.run(documentId, async () => {
      const existing = await this.load(documentId);
      if (existing) {
        return Ok(readAsMarkdown(existing));
      }

      const entry = createMirror(initialContent, filetype);
      await this.store.transaction(async (store) => {
        const seq = await store.appendUpdate({
          documentId,
          updateData: encodeState(entry),
          ...originColumns({ type: "system" }),
        });
        await store.upsertHead(this.headFor(documentId, entry, seq, null));
      });
      this.cache.set(documentId, entry);
      return Ok(readAsMarkdown(entry));
    });
  }

  forgetMirror(documentId: string): void {
    this.cache.delete(documentId);
  }

  async readAsMarkdown(documentId: string): Promise<Result<string, SyncError>> {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      return Ok(readAsMarkdown(entry));
    });
  }

  async editFromMarkdown(
    documentId: string,
    oldText: string,
    newText: string,
    origin: UpdateOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>> {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const full = readAsMarkdown(entry);
      const matchCount = oldText.length > 0 ? full.split(oldText).length - 1 : 0;
      if (matchCount === 0) {
        return Err<SyncError>({ code: "edit_not_found", oldText });
      }
      if (matchCount > 1) {
        return Err<SyncError>({ code: "ambiguous_edit", oldText, matchCount });
      }
      const index = full.indexOf(oldText);
      const target = full.slice(0, index) + newText + full.slice(index + oldText.length);
      const persisted = await this.applyTarget(documentId, entry, target, origin);
      return Ok(persisted);
    });
  }

  async writeFromMarkdown(
    documentId: string,
    markdown: string,
    origin: UpdateOrigin,
  ): Promise<Result<PersistedUpdate | null, SyncError>> {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const persisted = await this.applyTarget(documentId, entry, markdown, origin);
      return Ok(persisted);
    });
  }

  async transformFromMarkdown(
    documentId: string,
    transform: (markdown: string) => string,
    origin: UpdateOrigin,
  ): Promise<
    Result<
      { beforeMarkdown: string; markdown: string; persistedUpdate: PersistedUpdate | null },
      SyncError
    >
  > {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const beforeMarkdown = readAsMarkdown(entry);
      const markdown = transform(beforeMarkdown);
      const persistedUpdate = await this.applyTarget(documentId, entry, markdown, origin);
      return Ok({ beforeMarkdown, markdown, persistedUpdate });
    });
  }

  async checkpoint(documentId: string, reason: string): Promise<Result<string, SyncError>> {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const head = await this.store.getHead(documentId);
      if (!head) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const restorePoint = await this.store.transaction(async (store) => {
        const checkpointId = await this.createCheckpoint(store, documentId, entry, head, reason);
        return store.insertRestorePoint({
          documentId,
          name: reason,
          checkpointId,
          upToSeq: head.latestUpdateSeq,
          createdByUserId: null,
        });
      });
      return Ok(restorePoint.id);
    });
  }

  async restore(documentId: string, checkpointId: string): Promise<Result<void, SyncError>> {
    return this.run(documentId, async () => {
      const restorePoint = await this.store.getRestorePoint(checkpointId);
      if (
        !restorePoint ||
        restorePoint.documentId !== documentId ||
        restorePoint.checkpointId === null
      ) {
        return Err<SyncError>({ code: "checkpoint_not_found", checkpointId });
      }
      const checkpoint = await this.store.getCheckpoint(restorePoint.checkpointId);
      if (!checkpoint) {
        return Err<SyncError>({ code: "checkpoint_not_found", checkpointId });
      }

      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }

      const target = markdownFromState(entry.schemaType, checkpoint.state);
      await this.applyTarget(documentId, entry, target, { type: "system" });
      return Ok(undefined);
    });
  }

  async listCheckpoints(documentId: string): Promise<Result<CheckpointInfo[], SyncError>> {
    const points = await this.store.listRestorePoints(documentId);
    return Ok(
      points.map((point) => ({ id: point.id, reason: point.name, createdAt: point.createdAt })),
    );
  }

  async applyUpdate(
    documentId: string,
    update: Uint8Array,
    origin: UpdateOrigin,
  ): Promise<Result<void, SyncError>> {
    return this.run(documentId, async () => {
      const entry = await this.load(documentId);
      if (!entry) {
        return Err<SyncError>({ code: "not_found", documentId });
      }
      const staged = cloneMirror(entry);
      const effectiveUpdate = applyRemoteUpdate(staged, update, origin);
      if (!effectiveUpdate) {
        return Ok(undefined);
      }
      await this.persistUpdate(documentId, staged, effectiveUpdate, origin);
      applyRemoteUpdate(entry, effectiveUpdate, origin);
      return Ok(undefined);
    });
  }

  private async applyTarget(
    documentId: string,
    entry: MirrorEntry,
    target: string,
    origin: UpdateOrigin,
  ): Promise<PersistedUpdate | null> {
    const staged = cloneMirror(entry);
    const update = setDocumentToMarkdown(staged, target, origin);
    if (!update) {
      return null;
    }
    const persisted = await this.persistUpdate(documentId, staged, update, origin);
    applyRemoteUpdate(entry, update, origin);
    return persisted;
  }

  private run<T>(
    documentId: string,
    fn: () => Promise<Result<T, SyncError>>,
  ): Promise<Result<T, SyncError>> {
    return this.mutex.run(documentId, async () => {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof YjsDecodeError) {
          this.cache.delete(documentId);
          return Err<SyncError>({ code: "corrupt_state", documentId, message: error.message });
        }
        throw error;
      }
    });
  }

  private async load(documentId: string): Promise<MirrorEntry | null> {
    const cached = this.cache.get(documentId);
    if (cached) {
      return cached;
    }
    const head = await this.store.getHead(documentId);
    if (!head) {
      return null;
    }
    if (head.schemaVersion !== COLLAB_SCHEMA_VERSION) {
      this.cache.delete(documentId);
      throw new YjsDecodeError(
        `schema version ${head.schemaVersion} does not match current ${COLLAB_SCHEMA_VERSION}`,
      );
    }
    const checkpoint = await this.store.getLatestCheckpoint(documentId);
    const afterSeq = checkpoint ? checkpoint.upToSeq : 0;
    const updates = await this.store.listUpdatesAfter(documentId, afterSeq);
    const entry = rebuildMirror(
      head.filetype,
      checkpoint ? checkpoint.state : null,
      updates
        .filter((update) => update.seq <= head.latestUpdateSeq)
        .map((update) => update.updateData),
    );
    this.cache.set(documentId, entry);
    return entry;
  }

  private async persistUpdate(
    documentId: string,
    entry: MirrorEntry,
    update: Uint8Array,
    origin: UpdateOrigin,
  ): Promise<PersistedUpdate> {
    let updateSeq = 0;
    await this.store.transaction(async (store) => {
      updateSeq = await store.appendUpdate({
        documentId,
        updateData: update,
        ...originColumns(origin),
      });
      const head = await store.getHead(documentId);
      await store.upsertHead(
        this.headFor(documentId, entry, updateSeq, head?.latestCheckpointId ?? null),
      );
      await this.maybeAutoCheckpoint(store, documentId, entry, updateSeq);
    });
    return { updateSeq, updateData: update };
  }

  private async maybeAutoCheckpoint(
    store: DocumentStore,
    documentId: string,
    entry: MirrorEntry,
    latestSeq: number,
  ): Promise<void> {
    const checkpoint = await store.getLatestCheckpoint(documentId);
    const baseSeq = checkpoint ? checkpoint.upToSeq : 0;
    const since = (await store.listUpdatesAfter(documentId, baseSeq)).filter(
      (update) => update.seq <= latestSeq,
    ).length;
    if (since < this.autoCheckpointEvery) {
      return;
    }
    const head = await store.getHead(documentId);
    if (!head) {
      return;
    }
    await this.createCheckpoint(
      store,
      documentId,
      entry,
      { ...head, latestUpdateSeq: latestSeq },
      "auto",
    );
  }

  private async createCheckpoint(
    store: DocumentStore,
    documentId: string,
    entry: MirrorEntry,
    head: HeadRow,
    reason: string,
  ): Promise<number> {
    const checkpointId = await store.insertCheckpoint({
      documentId,
      state: encodeState(entry),
      stateVector: encodeStateVector(entry),
      upToSeq: head.latestUpdateSeq,
      reason,
    });
    await store.setLatestCheckpointId(documentId, checkpointId);
    return checkpointId;
  }

  private headFor(
    documentId: string,
    entry: MirrorEntry,
    latestUpdateSeq: number,
    latestCheckpointId: number | null,
  ): HeadRow {
    return {
      documentId,
      fragmentName: entry.fragmentName,
      schemaVersion: COLLAB_SCHEMA_VERSION,
      filetype: entry.filetype,
      latestUpdateSeq,
      latestStateVector: encodeStateVector(entry),
      latestCheckpointId,
    };
  }
}

export function createDocumentSyncService(
  store: DocumentStore,
  options?: DocumentSyncServiceOptions,
): DocumentSyncService {
  return new DocumentSyncService(store, options);
}
