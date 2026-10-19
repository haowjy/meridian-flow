// Host-only observation frontiers for rendered read and write results.
import type * as Y from "yjs";
import {
  type FrontierLookup,
  frontierBlockId,
  nextObservationFrontier,
  type ObservationFrontier,
  type ObservationRequest,
} from "../frontier.js";
import { blockHashesForDoc, getBlockItemId, getTopLevelXmlBlocks } from "../model/block-hash.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditModelPayload } from "./model-result.js";
import type { ObservationFailedDetail } from "./write-deps.js";

/**
 * `result` with the frontier of what it showed, rendered from `doc`, in `room`, chained from
 * the model's latest frontier there, when the host passed a lookup. A failure is reported and
 * leaves it off.
 */
export async function recordObservation(
  result: InternalWriteResult,
  doc: Y.Doc,
  room: string | null,
  recording: FrontierLookup | undefined,
  documentId: string,
  onFailed: ((event: ObservationFailedDetail) => void) | undefined,
): Promise<InternalWriteResult> {
  if (!room || !recording) return result;
  try {
    const prev = await recording(room);
    return { ...result, frontier: observeRendered(doc, { room, prev }, [result.model]) };
  } catch (cause) {
    onFailed?.({ documentId, cause });
    return result;
  }
}

/**
 * The frontier a result rendered from `doc` records. Shown in full: the blocks
 * of a full or partial read, and a write's `extent: full` changed blocks; an
 * outline, prefix context, copy edges and swept bodies show none, and neither
 * does a result reported with `awarenessDegraded`, whatever it rendered.
 */
export function observeRendered(
  doc: Y.Doc,
  observe: ObservationRequest,
  models: readonly (AgentEditModelPayload | undefined)[],
): ObservationFrontier {
  const shownHashes = new Set(
    models.flatMap((model) =>
      model?.read?.format === "outline" || model?.awarenessDegraded
        ? []
        : (model?.blocks ?? []).flatMap((group) =>
            group.extent === "full" && group.relation !== "swept"
              ? group.items.map((item) => item.hash)
              : [],
          ),
    ),
  );
  const shownInFull = new Set<string>();
  if (shownHashes.size > 0) {
    const blocks = getTopLevelXmlBlocks(doc);
    blockHashesForDoc(doc).forEach((hash, index) => {
      if (shownHashes.has(hash)) shownInFull.add(frontierBlockId(getBlockItemId(blocks[index])));
    });
  }
  return nextObservationFrontier(doc, observe, shownInFull);
}
