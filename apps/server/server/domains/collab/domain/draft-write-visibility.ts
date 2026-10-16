/**
 * After a reply merges into a prose draft, finds words it wrote into text the writer had already discarded.
 * Discard is a local edit of the draft text, so a reply still writing lands inside text that is gone: the
 * reply commits (no refusal), the discarded text stays discarded, and the writer and the model are told.
 */
import { countWords, invisibleInsertions } from "@meridian/agent-edit/diff";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import type * as Y from "yjs";
import type { NoticePort } from "../../notices/index.js";
import type { ReversalNoticeDiagnostics } from "./reversal-notices.js";

export type ReplyDraftWrite = { writeId: string; partIds: number[]; updates: Uint8Array[] };

export interface DraftWriteVisibilityStore {
  /** The reply's pending parts for one document, grouped by write. Empty for a live document. */
  readReplyWrites(input: {
    threadId: ThreadId;
    documentId: DocumentId;
    editScopeId: string;
  }): Promise<ReplyDraftWrite[]>;
  /** Runs `read` on the Work draft this thread writes into, as committed. */
  readDraft<T>(
    input: { threadId: ThreadId; documentId: DocumentId },
    read: (doc: Y.Doc) => T,
  ): Promise<T>;
  /** Records on the parts that their words landed invisible, for the turn receipt. */
  markInvisible(partIds: readonly number[]): Promise<void>;
}

export type DraftWriteVisibility = {
  report(input: {
    threadId: ThreadId;
    responseId: string;
    editScopeId: string;
    documentId: DocumentId;
  }): Promise<void>;
};

export function createDraftWriteVisibility(deps: {
  store: DraftWriteVisibilityStore;
  notices: NoticePort;
  resolveDocumentName(documentId: DocumentId): Promise<string>;
  diagnostics: ReversalNoticeDiagnostics;
}): DraftWriteVisibility {
  return {
    async report(input) {
      // The reply is already durable; a failed check costs the notice, never the reply.
      try {
        await check(input);
      } catch (cause) {
        deps.diagnostics.recordFailedAfterDurability({
          kind: "draft_write_invisible",
          threadId: input.threadId,
          documentIds: [input.documentId],
          responseId: input.responseId,
          cause,
        });
      }
    },
  };

  async function check(input: Parameters<DraftWriteVisibility["report"]>[0]) {
    const writes = await deps.store.readReplyWrites(input);
    if (writes.length === 0) return;
    const lost = await deps.store.readDraft(input, (doc) =>
      invisibleInsertions(
        doc,
        writes.map((write) => write.updates),
      ),
    );
    const hit = writes.filter((_, index) => lost[index]);
    if (hit.length === 0) return;
    await deps.store.markInvisible(hit.flatMap((write) => write.partIds));
    await deps.notices.record({
      kind: "draft_write_invisible",
      scope: { kind: "thread", threadId: input.threadId },
      message: `Your write to ${await deps.resolveDocumentName(input.documentId)} went into text the writer discarded, so it isn't visible.`,
      data: {
        responseId: input.responseId,
        documentId: input.documentId,
        writeIds: hit.map((write) => write.writeId),
        words: countWords(lost.join(" ")),
      },
    });
  }
}
