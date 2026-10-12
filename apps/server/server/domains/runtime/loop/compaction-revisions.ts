/** One settled-authority query per compaction phase; lookup failures mean unknown tokens. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Block, Turn } from "@meridian/contracts/threads";
import type { DocumentRevisions } from "../../context/index.js";
import {
  changedDocuments,
  collectRecordedDocuments,
  type DocumentTextPolicies,
  type RecordedDocuments,
} from "./compaction/elide.js";

export async function queryCompactionRevisions(input: {
  threadId: ThreadId;
  recorded: RecordedDocuments;
  revisions: DocumentRevisions;
  assertNoResponseScope: () => void;
}): Promise<Map<string, string | null>> {
  // An open response has staged text that settled authority cannot represent. This is
  // a programming error, not an unavailable revision, and must escape the fail-closed catch.
  input.assertNoResponseScope();
  // Null revisions are already stale, including edit records for discarded or rejected paths.
  const documentIds = [
    ...new Set(
      [...input.recorded.values()].flatMap(
        (refs) => refs?.filter((ref) => ref.revision !== null).map((ref) => ref.documentId) ?? [],
      ),
    ),
  ];
  try {
    return await input.revisions.current({ threadId: input.threadId, documentIds });
  } catch {
    return new Map(documentIds.map((id) => [id, null]));
  }
}

/** Collects changed document URIs from the exact model-visible source projection. */
export async function changedDocumentUris(input: {
  threadId: ThreadId;
  projection: { turns: readonly Turn[]; blocks: readonly Block[] };
  policies: DocumentTextPolicies;
  revisions: DocumentRevisions;
  assertNoResponseScope: () => void;
}): Promise<string[]> {
  const recorded = collectRecordedDocuments(
    input.projection.turns.map((turn) => ({
      turn,
      blocks: input.projection.blocks.filter((block) => block.turnId === turn.id),
    })),
    input.policies,
  );
  const current = await queryCompactionRevisions({
    threadId: input.threadId,
    recorded,
    revisions: input.revisions,
    assertNoResponseScope: input.assertNoResponseScope,
  });
  return [
    ...new Set(changedDocuments(recorded, current).flatMap((ref) => (ref.uri ? [ref.uri] : []))),
  ];
}
