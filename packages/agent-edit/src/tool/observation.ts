// Host-only observation frontiers, and the one listing of what changed that a result doesn't show.
import type * as Y from "yjs";
import type { AgentEditCodec } from "../codec-adapter.js";
import {
  type FrontierLookup,
  frontierBlockId,
  frontierDelta,
  type ObservationFrontier,
  recordedFrontier,
  writtenOnlyBy,
} from "../frontier.js";
import { toDocHandle, toRef } from "../handles.js";
import { renderedItems, type ShownCommandLinks, shownEvidence } from "../links/shown.js";
import {
  blockHashesForDoc,
  getBlockItemId,
  getTopLevelXmlBlocks,
  uniqueHashesForIds,
} from "../model/block-hash.js";
import { toHashline } from "../model/hashline.js";
import type { AgentEditModel } from "../ports/model.js";
import type { InternalWriteResult } from "./internal-result.js";
import {
  type AgentEditConcurrentListing,
  type AgentEditModelPayload,
  modelBlockItem,
} from "./model-result.js";
import type { ObservationFailedDetail } from "./write-deps.js";

/** The rendered listing's cap; what doesn't fit is named by count and stays unshown. */
export const CONCURRENT_LISTING_MAX_BYTES = 8 * 1024;

/** What renders a result's listing: the room doc it rendered from, and the command's links. */
export interface ListingSource {
  doc: Y.Doc;
  model: AgentEditModel;
  /** The command's links; without them (an echo that never rendered) nothing is listed. */
  links?: ShownCommandLinks & { codec: AgentEditCodec };
  /**
   * Blocks the result's own write removed, as `client:clock`: its receipt names them, so the
   * listing doesn't call them removed since the model last saw them.
   */
  ownRemoved?: ReadonlySet<string>;
  /**
   * The result's own write, as the updates it committed: a block holding only their text
   * counts as shown, since the model sent that text itself.
   */
  written?: readonly Uint8Array[];
}

/**
 * `result` with what it showed: its links, and, when the host passed a lookup, the listing of
 * blocks changed since the model's latest frontier in `room` that the result doesn't show,
 * and the frontier it records there. A lookup failure is reported and leaves both off.
 */
export async function recordObservation(
  result: InternalWriteResult,
  source: ListingSource,
  room: string | null,
  recording: FrontierLookup | undefined,
  documentId: string,
  onFailed: ((event: ObservationFailedDetail) => void) | undefined,
): Promise<InternalWriteResult> {
  let observed = result;
  if (room && recording) {
    try {
      const prev = await recording(room);
      const { frontier, concurrent } = observeRendered(source, room, prev, [result.model]);
      observed = {
        ...result,
        frontier,
        ...(concurrent ? { model: { ...result.model, concurrent } } : {}),
      };
    } catch (cause) {
      onFailed?.({ documentId, cause });
    }
  }
  return source.links
    ? { ...observed, ...shownEvidence(renderedItems(observed.model), source.links) }
    : observed;
}

/**
 * What results rendered from `source.doc` record, chained from `prev`: the listing
 * `changed − shown`, in document order until the byte cap, and the frontier
 * `unseen − shown − listed`. Shown in full: the blocks of a full or partial read, a
 * write's `extent: full` changed blocks, and the blocks that hold only the write's own text;
 * an outline, prefix context, copy edges and swept bodies show none, and neither does a
 * result reported with `awarenessDegraded`.
 */
export function observeRendered(
  source: ListingSource,
  room: string,
  prev: ObservationFrontier | null,
  models: readonly (AgentEditModelPayload | undefined)[],
): { frontier: ObservationFrontier; concurrent?: AgentEditConcurrentListing } {
  const { doc } = source;
  const delta = frontierDelta(doc, prev);
  const shown = shownInFull(doc, models);
  for (const id of writtenOnlyBy(doc, source.written ?? [])) shown.add(id);
  const blocks = getTopLevelXmlBlocks(doc);
  const byId = new Map(blocks.map((block) => [frontierBlockId(getBlockItemId(block)), block]));
  const candidates = delta.changed.filter((id) => !shown.has(id));
  const removed = delta.removed.filter((id) => !source.ownRemoved?.has(frontierBlockId(id)));
  if (!source.links || (candidates.length === 0 && removed.length === 0))
    return { frontier: recordedFrontier(room, delta, shown) };

  const items = source.model
    .serializeBlockLines(
      toDocHandle(doc),
      source.links.codec,
      candidates.map((id) => toRef(byId.get(id) as Y.XmlElement)),
    )
    .map(modelBlockItem);
  let remaining = CONCURRENT_LISTING_MAX_BYTES;
  const listed: string[] = [];
  const listing: AgentEditConcurrentListing = { blocks: [] };
  for (const [index, item] of items.entries()) {
    const bytes = byteLength(toHashline(item.hash, item.body)) + 1;
    if (bytes > remaining) break;
    remaining -= bytes;
    listing.blocks.push(item);
    listed.push(candidates[index]);
  }
  let more = candidates.length - listed.length;
  if (removed.length > 0 && more === 0) {
    const hashes = removedHashes(blocks, removed);
    const fitting: string[] = [];
    for (const hash of hashes) {
      const bytes = byteLength(hash) + 1;
      if (bytes > remaining) break;
      remaining -= bytes;
      fitting.push(hash);
    }
    if (fitting.length > 0) listing.removed = fitting;
    more += hashes.length - fitting.length;
  } else more += removed.length;
  if (more > 0) listing.more = more;
  return {
    frontier: recordedFrontier(room, delta, new Set([...shown, ...listed])),
    concurrent: listing,
  };
}

function shownInFull(
  doc: Y.Doc,
  models: readonly (AgentEditModelPayload | undefined)[],
): Set<string> {
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
  const shown = new Set<string>();
  if (shownHashes.size === 0) return shown;
  const blocks = getTopLevelXmlBlocks(doc);
  blockHashesForDoc(doc).forEach((hash, index) => {
    if (shownHashes.has(hash)) shown.add(frontierBlockId(getBlockItemId(blocks[index])));
  });
  return shown;
}

/** Removed blocks' hashes, unique among them and the present blocks, sorted. */
function removedHashes(
  present: readonly Y.XmlElement[],
  removed: readonly { clientID: number; clock: number }[],
): string[] {
  const hashes = uniqueHashesForIds([...present.map(getBlockItemId), ...removed]);
  return hashes.slice(present.length).sort();
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
