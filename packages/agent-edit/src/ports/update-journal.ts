import type { DocHandle } from "../handles.js";
import type { LineageRange } from "../lineage/range-set.js";
import type { SemanticEditIRV1 } from "../semantic-edit-ir.js";
import type { CompactionResult, JournalSnapshot, UpdateMeta } from "./types.js";

export type JournalCommitKind = "durable" | "staged";

type JournalMutationBase = {
  /** Ordered parts of one atomic edit. Storage adapters choose their journal row expansion. */
  editParts?: readonly Uint8Array[];
  threadId: string;
  turnId: string | null;
  authoringResponseId?: string;
  editScopeId?: string;
  /** Stable write attempt id; provider tool ids are scoped by response/turn before persistence. */
  writeId?: string;
  /** Pre-reserved durable ordinal rendered as w<N>. */
  wId?: number;
  /** The model's own tool call id (unscoped): the transcript row that made this write. */
  toolCallId?: string;
  actorKind: "agent" | "human" | "system";
  userId?: string;
  systemOrigin?: string;
  /** Certified semantic input bound to this exact lowered Yjs update. */
  semanticEditIr?: SemanticEditIRV1;
};

export type JournalMutation = JournalMutationBase &
  (
    | { mode: "live" }
    | {
        mode: "threadPeer";
        /** Host branch generation captured with the write baseline. */
        draftGeneration: number;
        /** Peer that accepted this buffered write, not its shared upstream. */
        peerDraftId?: string;
      }
  );

export type JournalAuthority = { authorityId: string; generation: bigint };

export interface JournalBatchAppendEntry {
  /** Authority of the canonical handle used to prepare this update. */
  authority?: JournalAuthority;
  docId: string;
  update: Uint8Array;
  meta: UpdateMeta;
  /** Present for agent edit writes that need durable per-write metadata. */
  mutation?: JournalMutation;
}

export interface JournalBatchAppendResult {
  seq: number;
  /** Whether this append created durable truth, or only queued pending branch state. */
  journalCommitKind: JournalCommitKind;
  /** Durable monotonic ordinal per (documentId, threadId), present only for mutation entries. */
  wId?: number;
}

export interface JournalReadOptions {
  since?: number;
  until?: number;
}

/** Ordered Yjs update log; checkpoint production belongs to the host. */
export interface UpdateJournal {
  /** Reserve one durable per-document/thread ordinal before staging an edit. */
  reserveWriteOrdinal(documentId: string, threadId: string): Promise<number>;
  append(
    docId: string,
    update: Uint8Array,
    meta: UpdateMeta,
    authority?: JournalAuthority,
  ): Promise<number>;
  /** Append logical edit envelopes atomically; the storage adapter expands their ordered parts. */
  appendBatch(entries: readonly JournalBatchAppendEntry[]): Promise<JournalBatchAppendResult[]>;
  read(docId: string, opts?: JournalReadOptions): Promise<JournalSnapshot>;
  /** Durable attributed base used when reporting destructive effects. */
  readAttribution?(docId: string): Promise<JournalSnapshot>;
  compact(docId: string, before: Date): Promise<CompactionResult>;
  /** Optional host authority for exact destructive-report provenance. */
  materializeDestructiveProvenance?(input: {
    docId: string;
    before: DocHandle;
    afterCandidate: DocHandle;
    /** Draft adapters classify roots absent from the live document as agent-authored. */
    fallbackProvenance?: "writer_protected" | "agent";
  }): Promise<{
    before: DestructiveProvenanceRun[];
    afterCandidate: DestructiveProvenanceRun[];
  }>;
}

export interface DestructiveProvenanceRun {
  target: LineageRange;
  root: LineageRange;
  provenance: "writer_protected" | "agent";
}

export function writeHandle(wId: number): string {
  return `w${wId}`;
}
