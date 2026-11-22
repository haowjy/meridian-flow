/**
 * A document a Work creates is plain text in Live: its create is pending in the Work's tree, which
 * is its whole pending state, and the document opens in the Work's view as soon as the create is
 * admitted.
 */
import type { EffectiveDocumentReader } from "../contracts.js";
import type { MarkdownDocumentEngine } from "./markdown-document.js";

export function createWorkCreates(deps: {
  documents: Pick<MarkdownDocumentEngine, "writeCreatedContent">;
}): Pick<EffectiveDocumentReader, "writeWorkCreatedContent"> {
  return {
    async writeWorkCreatedContent(created, origin) {
      for (const { documentId, content } of created)
        await deps.documents.writeCreatedContent({ documentId, content, origin });
    },
  };
}
