// Host-only observation frontiers for rendered read and write results.
import type * as Y from "yjs";
import { frontierBlockId, nextObservationFrontier, type ObservationFrontier } from "../frontier.js";
import { blockHashesForDoc, getBlockItemId, getTopLevelXmlBlocks } from "../model/block-hash.js";
import type { AgentEditModelPayload } from "./model-result.js";

/**
 * The frontier a result rendered from `doc` records. Shown in full: the blocks
 * of a full or partial read, and a write's `extent: full` changed blocks; an
 * outline, prefix context, copy edges and swept bodies show none.
 */
export function observeRendered(
  doc: Y.Doc,
  prev: ObservationFrontier | null,
  models: readonly (AgentEditModelPayload | undefined)[],
): ObservationFrontier {
  const shownHashes = new Set(
    models.flatMap((model) =>
      model?.read?.format === "outline"
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
  return nextObservationFrontier(doc, prev, shownInFull);
}
