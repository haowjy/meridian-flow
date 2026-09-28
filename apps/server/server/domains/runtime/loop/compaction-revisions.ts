/** One settled-authority query per compaction phase; lookup failures mean unknown tokens. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { DocumentRevisions } from "../../context/index.js";
import type { RecordedDocuments } from "./compaction/elide.js";

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
