/** Draft capabilities consumed by collab application services. */
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { DraftResolver, ResolvedDraft } from "../draft-resolver.js";
import type { DraftSnapshot, DraftStore } from "../draft-store.js";

export type ApplicationDraftStore = DraftStore &
  DraftResolver & {
    listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
    /**
     * The branch's draft on the document, made from `liveDoc` if absent: a write boundary
     * only. Never makes a branch; refuses a closed one in the insert's transaction.
     */
    ensureDocumentDraft(input: {
      documentId: DocumentId;
      branchId: BranchId;
      liveDoc: Y.Doc;
      /** Addressable authority room, or intentional null for created/empty content. */
      liveRoom: string | null;
      livePosition?: number;
    }): Promise<DraftSnapshot>;
    /** The branch's draft on its new document, from its durable live state, in the caller's transaction. */
    ensureCreatedDocumentDraft(input: {
      documentId: DocumentId;
      branchId: BranchId;
    }): Promise<void>;
    /**
     * Close the branch's draft on a document it created and that draft's thread peers,
     * unless any of them holds a journal row that isn't discarded (a contribution).
     */
    retractCreatedDocumentDraft(input: {
      documentId: DocumentId;
      branchId: BranchId;
    }): Promise<"stands" | "retracted">;
    /**
     * The thread's peer of the branch's draft on the document. Takes the branch it is given,
     * never ensures one; a branch that is no longer active is `DraftStaleUpdateError`.
     * `liveDoc` is asked for only when the branch has no draft of the document to fork from.
     */
    ensureThreadPeerDraft(input: {
      documentId: DocumentId;
      threadId: ThreadId;
      branchId: BranchId;
      liveDoc: () => Promise<{ doc: Y.Doc; room: string | null; position?: number }>;
    }): Promise<{ documentDraft: DraftSnapshot; workDraft: DraftSnapshot }>;
    /** The thread's primary Work's active draft on the document, as metadata. */
    resolveWorkDraftForThread(documentId: DocumentId, threadId: ThreadId): Promise<ResolvedDraft>;
  };
