/** Reference snapshots use the ordinary tracked read, with a pinned document identity. */
import type { JsonValue } from "@meridian/contracts/threads";
import type { ReferenceReader } from "../../domains/runtime/index.js";
import { readTrackedDocument } from "./document-tools.js";
import type { ToolWiringDeps } from "./tool-context.js";

export function createReferenceReader(deps: ToolWiringDeps): ReferenceReader {
  return {
    async read(reference, ctx) {
      const outcome = await readTrackedDocument(deps, ctx.input ?? { path: reference.uri }, ctx, {
        expectedDocumentId: reference.documentId,
        ...(ctx.recordingFrontier ? { recordingFrontier: ctx.recordingFrontier } : {}),
      });
      return {
        result: JSON.parse(JSON.stringify(outcome.output)) as JsonValue,
        revision: outcome.revision,
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      };
    },
  };
}
