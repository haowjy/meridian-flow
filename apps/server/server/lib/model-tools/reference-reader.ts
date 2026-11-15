/** Reference snapshots use the ordinary tracked read, with a pinned document identity: a binary file a writer mentions is shown to the model exactly as one the agent reads. */
import type { JsonValue } from "@meridian/contracts/threads";
import type { ChatMediaPort, ReferenceReader } from "../../domains/runtime/index.js";
import { readTrackedDocument } from "./document-tools.js";
import type { ToolWiringDeps } from "./tool-context.js";

export function createReferenceReader(
  deps: ToolWiringDeps,
  chatMedia: Pick<ChatMediaPort, "admit">,
): ReferenceReader {
  return {
    async read(reference, ctx) {
      const outcome = await readTrackedDocument(deps, ctx.input ?? { path: reference.uri }, ctx, {
        expectedDocumentId: reference.documentId,
        placement: "user-message",
        ...(ctx.model ? { model: ctx.model } : {}),
        ...(ctx.recordingFrontier ? { recordingFrontier: ctx.recordingFrontier } : {}),
      });
      const result = JSON.parse(JSON.stringify(outcome.output)) as JsonValue;
      // A file the read shows as media is sent: later turns read the chat's own copy of it.
      const file = (result as { file?: { given?: unknown; documentId?: unknown } } | null)?.file;
      if (file?.given === "media" && typeof file.documentId === "string") {
        const sent = await chatMedia.admit(ctx.threadId, file.documentId);
        if (sent?.chatCopy) Object.assign(file, { chatCopy: sent.chatCopy });
      }
      return {
        result,
        revision: outcome.revision,
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      };
    },
  };
}
