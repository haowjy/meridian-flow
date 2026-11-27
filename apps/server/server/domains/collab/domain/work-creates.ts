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
