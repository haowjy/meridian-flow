/** In-memory branch resolver skeleton used by domain conformance tests. */

import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import {
  BranchCorruptError,
  BranchNotFoundError,
  type BranchResolver,
  type BranchState,
} from "../branch-resolver.js";
import { isStaleSchema, StaleDocumentSchemaError } from "../stale-schema.js";

export type BranchKind = "work_draft" | "thread_peer";
export type BranchStatus = "active" | "closed";
export type BranchPushPolicy = "manual" | "auto";

export type InMemoryDocumentBranchRow = {
  id: string;
  documentId: DocumentId;
  kind: BranchKind;
  upstreamBranchId: string | null;
  workId: WorkId | null;
  threadId: ThreadId | null;
  pushPolicy: BranchPushPolicy;
  generation: number;
  state: Uint8Array | null;
  stateVector: Uint8Array | null;
  status: BranchStatus;
  schemaVersion: number;
};

export type SeedWorkDraftInput = {
  documentId: DocumentId;
  workId: WorkId;
  doc: Y.Doc;
  branchId?: string;
  generation?: number;
  schemaVersion?: number;
};

export type CreateThreadPeerInput = {
  documentId: DocumentId;
  threadId: ThreadId;
  upstreamBranchId: string;
  branchId?: string;
};

export type ResetBranchInput = {
  branchId: string;
  expectedGeneration: number;
};

export class InMemoryBranchStore implements BranchResolver {
  readonly rows = new Map<string, InMemoryDocumentBranchRow>();

  #nextBranchNumber = 1;
  readonly #schemaVersion: number;

  constructor(options: { schemaVersion?: number } = {}) {
    this.#schemaVersion = options.schemaVersion ?? COLLAB_SCHEMA_VERSION;
  }

  async resolveThreadBranch(documentId: DocumentId, threadId: ThreadId): Promise<BranchState> {
    const row = this.findActiveThreadPeer(documentId, threadId);
    if (!row) {
      throw new BranchNotFoundError(documentId, threadId);
    }
    return {
      branchId: row.id,
      doc: this.materialize(row, { documentId, threadId }),
      generation: row.generation,
    };
  }

  seedWorkDraft(input: SeedWorkDraftInput): InMemoryDocumentBranchRow {
    const row: InMemoryDocumentBranchRow = {
      id: input.branchId ?? this.nextBranchId(),
      documentId: input.documentId,
      kind: "work_draft",
      upstreamBranchId: null,
      workId: input.workId,
      threadId: null,
      pushPolicy: "manual",
      generation: input.generation ?? 1,
      state: Y.encodeStateAsUpdate(input.doc),
      stateVector: Y.encodeStateVector(input.doc),
      status: "active",
      schemaVersion: input.schemaVersion ?? this.#schemaVersion,
    };
    this.insert(row);
    return row;
  }

  createThreadPeerFromUpstream(input: CreateThreadPeerInput): InMemoryDocumentBranchRow {
    const upstream = this.rows.get(input.upstreamBranchId);
    if (upstream?.status !== "active") {
      throw new BranchNotFoundError(input.documentId, input.threadId);
    }
    const upstreamDoc = this.materialize(upstream, {
      documentId: input.documentId,
      threadId: input.threadId,
    });
    const row: InMemoryDocumentBranchRow = {
      id: input.branchId ?? this.nextBranchId(),
      documentId: input.documentId,
      kind: "thread_peer",
      upstreamBranchId: upstream.id,
      workId: upstream.workId,
      threadId: input.threadId,
      pushPolicy: upstream.pushPolicy,
      generation: 1,
      state: Y.encodeStateAsUpdate(upstreamDoc),
      stateVector: Y.encodeStateVector(upstreamDoc),
      status: "active",
      schemaVersion: upstream.schemaVersion,
    };
    this.insert(row);
    return row;
  }

  resetFromUpstream(input: ResetBranchInput): InMemoryDocumentBranchRow {
    const row = this.rows.get(input.branchId);
    if (!row) {
      throw new Error(`Branch ${input.branchId} does not exist`);
    }
    if (row.generation !== input.expectedGeneration) {
      throw new Error(
        `Branch ${input.branchId} generation ${row.generation} did not match expected ${input.expectedGeneration}`,
      );
    }
    if (!row.upstreamBranchId) {
      throw new Error(`Branch ${input.branchId} has no upstream branch to reset from`);
    }
    const upstream = this.rows.get(row.upstreamBranchId);
    if (upstream?.status !== "active") {
      throw new Error(`Branch ${input.branchId} upstream ${row.upstreamBranchId} is not active`);
    }
    const upstreamDoc = this.materialize(upstream, {
      documentId: row.documentId,
      threadId: row.threadId ?? ("" as ThreadId),
    });
    const next: InMemoryDocumentBranchRow = {
      ...row,
      generation: row.generation + 1,
      state: Y.encodeStateAsUpdate(upstreamDoc),
      stateVector: Y.encodeStateVector(upstreamDoc),
      schemaVersion: upstream.schemaVersion,
    };
    this.rows.set(next.id, next);
    return next;
  }

  insert(row: InMemoryDocumentBranchRow): void {
    this.assertOwnerShape(row);
    this.rows.set(row.id, row);
  }

  findActiveThreadPeer(
    documentId: DocumentId,
    threadId: ThreadId,
  ): InMemoryDocumentBranchRow | undefined {
    for (const row of this.rows.values()) {
      if (
        row.documentId === documentId &&
        row.threadId === threadId &&
        row.kind === "thread_peer" &&
        row.status === "active"
      ) {
        return row;
      }
    }
    return undefined;
  }

  private materialize(
    row: InMemoryDocumentBranchRow,
    context: { documentId: DocumentId; threadId: ThreadId },
  ): Y.Doc {
    if (isStaleSchema(row.schemaVersion, this.#schemaVersion)) {
      throw new StaleDocumentSchemaError(row.documentId, row.schemaVersion, this.#schemaVersion);
    }
    if (!row.state || !row.stateVector) {
      throw new BranchCorruptError({ branchId: row.id, ...context });
    }
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, row.state);
      Y.encodeStateVector(doc);
      return doc;
    } catch (cause) {
      throw new BranchCorruptError({ branchId: row.id, ...context, cause });
    }
  }

  private assertOwnerShape(row: InMemoryDocumentBranchRow): void {
    if (row.kind === "work_draft" && (!row.workId || row.threadId)) {
      throw new Error("work_draft branches must have workId and no threadId");
    }
    if (row.kind === "thread_peer" && !row.threadId) {
      throw new Error("thread_peer branches must have threadId");
    }
  }

  private nextBranchId(): string {
    return `branch-${this.#nextBranchNumber++}`;
  }
}

export function createInMemoryBranchStore(options?: {
  schemaVersion?: number;
}): InMemoryBranchStore {
  return new InMemoryBranchStore(options);
}
