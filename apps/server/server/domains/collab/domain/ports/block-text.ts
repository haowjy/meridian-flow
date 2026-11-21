/**
 * Read port for the stored block rows a save certifies. Each read answers only for documents
 * whose derived outputs are current; a document left out is unknown here and its caller reads
 * the document itself. The writer side is `DocumentDerivationStore`.
 */
import type { DraftId } from "@meridian/contracts";
import type { DocumentId } from "@meridian/contracts/runtime";

export type BlockText = {
  /**
   * Stored grep text of the documents whose derived outputs are current: the blocks' text
   * joined with `\n` in block order, in one statement with the freshness check. The text is
   * Live's: a reader whose draft has suggestions in a document sees its own view,
   * so that document is left out.
   */
  grepTexts(ids: DocumentId[], reader: { draft: DraftId | null }): Promise<Map<DocumentId, string>>;
  /**
   * Words per document, as the current derivation counted them. A document whose derivation is
   * behind (or never ran) is absent: `ls` omits its count rather than show a stale one, since
   * counting the room copy would read every listed document.
   */
  wordCounts(ids: DocumentId[]): Promise<Map<DocumentId, number>>;
};
