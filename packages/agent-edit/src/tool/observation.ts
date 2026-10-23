// Host-only observation frontiers, and the one listing of what changed that a result doesn't show.
import * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import {
  type FrontierLookup,
  frontierBlockId,
  frontierDelta,
  type ObservationFrontier,
  planningSnapshot,
  recordedFrontier,
  writtenOnlyBy,
} from "../frontier.js";
import { toDocHandle, toRef } from "../handles.js";
import { renderedItems, type ShownCommandLinks, shownEvidence } from "../links/shown.js";
import {
  blockHashesForDoc,
  blockIdentityForItem,
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
  /** Agent turns whose writes this result is reporting, never concurrent peers. */
  ownActorTurnIds?: ReadonlySet<string>;
  /** Origin-aware effective updates between the previous frontier and this rendered cut. */
  concurrent?: readonly ConcurrentUpdate[];
  /** Host attribution lookup over a materialized copy of the previous frontier. */
  loadConcurrent?: (baseline: Y.Doc) => Promise<readonly ConcurrentUpdate[]>;
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
      const concurrent = await loadConcurrent(source, prev);
      const observedSource = concurrent ? { ...source, concurrent } : source;
      const { frontier, concurrent: listing } = observeRendered(observedSource, room, prev, [
        result.model,
      ]);
      observed = {
        ...result,
        frontier,
        ...(listing ? { model: { ...result.model, concurrent: listing } } : {}),
      };
    } catch (cause) {
      onFailed?.({ documentId, cause });
    }
  }
  return source.links
    ? { ...observed, ...shownEvidence(renderedItems(observed.model), source.links) }
    : observed;
}

export async function loadConcurrent(
  source: ListingSource,
  prev: ObservationFrontier | null,
): Promise<readonly ConcurrentUpdate[] | undefined> {
  const at = prev && planningSnapshot(source.doc, prev.room, prev);
  if (!at || !source.loadConcurrent) return source.concurrent;
  const baseline = YDocFromSnapshot(source.doc, at);
  try {
    return await source.loadConcurrent(baseline);
  } finally {
    baseline.destroy();
  }
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
  if (!source.links || (delta.changed.length === 0 && removed.length === 0))
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
  const authors = changeAuthors(source, prev, delta.changed, delta.removed);
  const itemById = new Map(candidates.map((id, index) => [id, items[index]]));
  const removedById = removedHashMap(doc, blocks, removed);
  const groups: AgentEditConcurrentListing["groups"] = [];
  for (const [author, changes] of authors) {
    const group: AgentEditConcurrentListing["groups"][number] = { author, blocks: [] };
    for (const id of changes.changed) {
      const item = itemById.get(id);
      if (!item) {
        if (shown.has(id)) {
          group.shown ??= [];
          group.shown.push(hashForId(doc, blocks, id));
        }
        continue;
      }
      const bytes = byteLength(toHashline(item.hash, item.body)) + 1;
      if (bytes > remaining) {
        group.more = (group.more ?? 0) + 1;
        continue;
      }
      remaining -= bytes;
      group.blocks.push(item);
      listed.push(id);
    }
    for (const id of changes.removed) {
      const hash = removedById.get(id);
      if (!hash || byteLength(hash) + 1 > remaining) {
        group.more = (group.more ?? 0) + 1;
        continue;
      }
      remaining -= byteLength(hash) + 1;
      group.removed ??= [];
      group.removed.push(hash);
    }
    if (group.blocks.length || group.shown?.length || group.removed?.length || group.more)
      groups.push(group);
  }
  const listing: AgentEditConcurrentListing = { groups };
  return {
    frontier: recordedFrontier(room, delta, new Set([...shown, ...listed])),
    ...(groups.length ? { concurrent: listing } : {}),
  };
}

type AuthorChanges = { changed: Set<string>; removed: Set<string> };

/** Attribute each changed block to every peer update that affected it. */
function changeAuthors(
  source: ListingSource,
  prev: ObservationFrontier | null,
  changed: readonly string[],
  removed: readonly { clientID: number; clock: number }[],
): Map<string, AuthorChanges> {
  const relevantChanged = new Set(changed);
  const relevantRemoved = new Set(removed.map(frontierBlockId));
  const ownChanged = new Set<string>();
  const ownRemoved = new Set<string>();
  const byAuthor = new Map<string, AuthorChanges>();
  const previousSnapshot = prev && planningSnapshot(source.doc, prev.room, prev);
  const baseline = previousSnapshot ? YDocFromSnapshot(source.doc, previousSnapshot) : null;
  if (baseline) {
    try {
      for (const item of source.concurrent ?? []) {
        const own =
          (source.written ?? []).some((own) => bytesEqual(own, item.update)) ||
          (item.origin.type === "agent" &&
            source.ownActorTurnIds?.has(item.origin.actorTurnId) === true);
        const before: ObservationFrontier = {
          room: prev?.room ?? "",
          snapshot: Y.encodeSnapshotV2(Y.snapshot(baseline)),
          unshown: [],
        };
        Y.applyUpdate(baseline, item.update);
        const effect = frontierDelta(baseline, before);
        if (own) {
          effect.changed.forEach((id) => {
            ownChanged.add(id);
          });
          effect.removed.map(frontierBlockId).forEach((id) => {
            ownRemoved.add(id);
          });
          continue;
        }
        const author =
          item.origin.type === "agent" ? (item.origin.author ?? "the user") : "the user";
        const group = byAuthor.get(author) ?? { changed: new Set(), removed: new Set() };
        effect.changed
          .filter((id) => relevantChanged.has(id))
          .forEach((id) => {
            group.changed.add(id);
          });
        effect.removed
          .map(frontierBlockId)
          .filter((id) => relevantRemoved.has(id))
          .forEach((id) => {
            group.removed.add(id);
          });
        byAuthor.set(author, group);
      }
    } finally {
      baseline.destroy();
    }
  }
  const attributedChanged = new Set([...byAuthor.values()].flatMap((group) => [...group.changed]));
  const attributedRemoved = new Set([...byAuthor.values()].flatMap((group) => [...group.removed]));
  const fallback = {
    changed: new Set(changed.filter((id) => !attributedChanged.has(id) && !ownChanged.has(id))),
    removed: new Set(
      [...relevantRemoved].filter((id) => !attributedRemoved.has(id) && !ownRemoved.has(id)),
    ),
  };
  if (fallback.changed.size || fallback.removed.size) {
    const user = byAuthor.get("the user") ?? { changed: new Set(), removed: new Set() };
    fallback.changed.forEach((id) => {
      user.changed.add(id);
    });
    fallback.removed.forEach((id) => {
      user.removed.add(id);
    });
    byAuthor.set("the user", user);
  }
  return byAuthor;
}

function YDocFromSnapshot(doc: Y.Doc, at: Y.Snapshot): Y.Doc {
  return Y.createDocFromSnapshot(doc, at, new Y.Doc({ gc: false }));
}

function hashForId(doc: Y.Doc, blocks: readonly Y.XmlElement[], id: string): string {
  const index = blocks.findIndex((block) => frontierBlockId(getBlockItemId(block)) === id);
  return blockHashesForDoc(doc)[index] ?? id;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
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
            group.extent === "full" ? group.items.map((item) => item.hash) : [],
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

function removedHashMap(
  doc: Y.Doc,
  present: readonly Y.XmlElement[],
  removed: readonly { clientID: number; clock: number }[],
): Map<string, string> {
  const hashes = uniqueHashesForIds([
    ...present.map((block) => blockIdentityForItem(doc, getBlockItemId(block))),
    ...removed.map((id) => blockIdentityForItem(doc, id)),
  ]).slice(present.length);
  return new Map(removed.map((id, index) => [frontierBlockId(id), hashes[index]]));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
