// Host-only observation frontiers and the attributed listing of concurrent changes.
import * as Y from "yjs";
import type { ConcurrentUpdate } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import {
  type FrontierLookup,
  frontierBlockId,
  frontierDelta,
  type ObservationFrontier,
  planningSnapshot,
  type ResolvedObservationFrontier,
  recordedFrontier,
  writtenOnlyBy,
} from "../frontier.js";
import { toDocHandle } from "../handles.js";
import { renderedItems, type ShownCommandLinks, shownEvidence } from "../links/shown.js";
import {
  blockHashesForDoc,
  blockIdentityForItem,
  getBlockItemId,
  getTopLevelXmlBlocks,
  uniqueHashesForIds,
} from "../model/block-hash.js";
import { toHashline } from "../model/hashline.js";
import type { AgentEditModel, ProjectedBlock } from "../ports/model.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditConcurrentListing, AgentEditModelPayload } from "./model-result.js";
import type { ObservationFailedDetail } from "./write-deps.js";

/** The rendered listing's cap. */
export const CONCURRENT_LISTING_MAX_BYTES = 8 * 1024;

export interface ListingSource {
  doc: Y.Doc;
  model: AgentEditModel;
  links?: ShownCommandLinks & { codec: AgentEditCodec };
  ownRemoved?: ReadonlySet<string>;
  written?: readonly Uint8Array[];
  ownActorTurnIds?: ReadonlySet<string>;
  /** Host journal high-water mark for `doc`. */
  position?: number;
  concurrent?: readonly ConcurrentUpdate[];
  /** The host's one bounded attribution lookup for this rendered cut. */
  loadConcurrent?: (input: {
    baseline: Y.Doc;
    after: number;
    through: number;
    attributionBridge?: ResolvedObservationFrontier["attributionBridge"];
  }) => Promise<readonly ConcurrentUpdate[]>;
}

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
  prev: ResolvedObservationFrontier | null,
): Promise<readonly ConcurrentUpdate[] | undefined> {
  const at = prev && planningSnapshot(source.doc, prev.room, prev);
  if (
    !at ||
    !source.loadConcurrent ||
    prev.position === undefined ||
    source.position === undefined ||
    prev.position > source.position
  )
    return source.concurrent;
  // Snapshot equality includes delete sets, so this skips both insert-only and delete-only no-ops.
  if (!prev.attributionBridge && Y.equalSnapshots(Y.snapshot(source.doc), at))
    return source.concurrent;
  const baseline = YDocFromSnapshot(source.doc, at);
  try {
    return await source.loadConcurrent({
      baseline,
      after: prev.position,
      through: source.position,
      ...(prev.attributionBridge ? { attributionBridge: prev.attributionBridge } : {}),
    });
  } finally {
    baseline.destroy();
  }
}

export function observeRendered(
  source: ListingSource,
  room: string,
  prev: ResolvedObservationFrontier | null,
  models: readonly (AgentEditModelPayload | undefined)[],
): { frontier: ObservationFrontier; concurrent?: AgentEditConcurrentListing } {
  const { doc } = source;
  const delta = frontierDelta(doc, prev);
  const projectedChanged = new Set(
    (source.concurrent ?? []).flatMap((item) => [...(item.effects?.changed ?? [])]),
  );
  const changed = [...new Set([...delta.changed, ...projectedChanged])];
  const projectedRemoved = (source.concurrent ?? []).flatMap((item) => [
    ...(item.effects?.removed ?? []),
  ]);
  const removedIds = [...delta.removed, ...projectedRemoved.map(parseFrontierBlockId)].filter(
    (id, index, all) =>
      all.findIndex((candidate) => frontierBlockId(candidate) === frontierBlockId(id)) === index,
  );
  const shown = shownInFull(doc, models);
  for (const id of writtenOnlyBy(doc, source.written ?? [])) shown.add(id);
  const removed = removedIds.filter((id) => !source.ownRemoved?.has(frontierBlockId(id)));
  const frontier = recordedFrontier(room, delta, source.position);
  if (!source.links || (changed.length === 0 && removed.length === 0)) return { frontier };

  const projected = source.model.projectBlocks(toDocHandle(doc));
  const byId = new Map(projected.map((block) => [frontierBlockId(block.id), block]));
  const candidates = changed.filter((id) => !shown.has(id) && byId.has(id));
  const rendered = candidates.map((id) => byId.get(id) as ProjectedBlock);
  const bodies = source.links.codec.serializeBlocks(
    rendered.map((block) => block.node),
    rendered.map((block) => block.hash),
  );
  const items = rendered.map((block, index) => ({ hash: block.hash, body: bodies[index] }));
  const authors = changeAuthors(source, prev, changed, removedIds);
  const itemById = new Map(candidates.map((id, index) => [id, items[index]]));
  const hashes = hashMap(doc, projected, removed);
  const groups: AgentEditConcurrentListing["groups"] = [];
  let remaining = CONCURRENT_LISTING_MAX_BYTES;
  for (const [author, changes] of authors) {
    const group: AgentEditConcurrentListing["groups"][number] = { author, blocks: [] };
    for (const id of changes.changed) {
      const item = itemById.get(id);
      if (!item) {
        if (!shown.has(id)) continue;
        const hash = hashes.get(id);
        if (!hash) continue;
        const bytes = byteLength(hash) + 1;
        if (bytes > remaining) {
          group.more = (group.more ?? 0) + 1;
          continue;
        }
        remaining -= bytes;
        group.shown ??= [];
        group.shown.push(hash);
        continue;
      }
      const bytes = byteLength(toHashline(item.hash, item.body)) + 1;
      if (bytes > remaining) {
        group.more = (group.more ?? 0) + 1;
        continue;
      }
      remaining -= bytes;
      group.blocks.push(item);
    }
    for (const id of changes.removed) {
      const hash = hashes.get(id);
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
  return { frontier, ...(groups.length ? { concurrent: { groups } } : {}) };
}

type AuthorChanges = { changed: Set<string>; removed: Set<string> };

function changeAuthors(
  source: ListingSource,
  prev: ResolvedObservationFrontier | null,
  changed: readonly string[],
  removed: readonly { clientID: number; clock: number }[],
): Map<string, AuthorChanges> {
  const relevantChanged = new Set(changed);
  const relevantRemoved = new Set(removed.map(frontierBlockId));
  const ownChanged = new Set<string>();
  const ownRemoved = new Set(source.ownRemoved ?? []);
  const byAuthor = new Map<string, AuthorChanges>();
  const previousSnapshot = prev && planningSnapshot(source.doc, prev.room, prev);
  const baseline = previousSnapshot ? YDocFromSnapshot(source.doc, previousSnapshot) : null;
  if (baseline) {
    try {
      const own = new Y.Doc({ gc: false });
      Y.applyUpdate(own, Y.encodeStateAsUpdate(baseline));
      try {
        for (const update of source.written ?? []) {
          const effect = updateEffect(own, update, prev?.room ?? "");
          effect.changed.forEach((id) => {
            ownChanged.add(id);
          });
          effect.removed.map(frontierBlockId).forEach((id) => {
            ownRemoved.add(id);
          });
        }
      } finally {
        own.destroy();
      }
      for (const item of source.concurrent ?? []) {
        const own =
          (source.written ?? []).some((update) => bytesEqual(update, item.update)) ||
          (item.origin.type === "agent" &&
            source.ownActorTurnIds?.has(item.origin.actorTurnId) === true);
        const effect = item.effects
          ? {
              changed: [...item.effects.changed],
              removed: item.effects.removed.map(parseFrontierBlockId),
            }
          : updateEffect(baseline, item.update, prev?.room ?? "");
        if (own) {
          effect.changed.forEach((id) => {
            ownChanged.add(id);
          });
          effect.removed.map(frontierBlockId).forEach((id) => {
            ownRemoved.add(id);
          });
          continue;
        }
        const author = authorLabel(item.origin);
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
  const fallback = byAuthor.get("unattributed") ?? { changed: new Set(), removed: new Set() };
  changed
    .filter((id) => !attributedChanged.has(id) && !ownChanged.has(id))
    .forEach((id) => {
      fallback.changed.add(id);
    });
  [...relevantRemoved]
    .filter((id) => !attributedRemoved.has(id) && !ownRemoved.has(id))
    .forEach((id) => {
      fallback.removed.add(id);
    });
  if (fallback.changed.size || fallback.removed.size) byAuthor.set("unattributed", fallback);
  return byAuthor;
}

function authorLabel(origin: ConcurrentUpdate["origin"]): string {
  if (origin.type === "agent") return origin.author ?? "agent";
  if (origin.type === "human") return "the user";
  return "unattributed";
}

function updateEffect(baseline: Y.Doc, update: Uint8Array, room: string) {
  const before: ObservationFrontier = {
    room,
    snapshot: Y.encodeSnapshotV2(Y.snapshot(baseline)),
  };
  Y.applyUpdate(baseline, update);
  return frontierDelta(baseline, before);
}

function parseFrontierBlockId(id: string): { clientID: number; clock: number } {
  const [clientID, clock] = id.split(":").map(Number);
  return { clientID, clock };
}

function YDocFromSnapshot(doc: Y.Doc, at: Y.Snapshot): Y.Doc {
  return Y.createDocFromSnapshot(doc, at, new Y.Doc({ gc: false }));
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

function hashMap(
  doc: Y.Doc,
  present: readonly ProjectedBlock[],
  removed: readonly { clientID: number; clock: number }[],
): Map<string, string> {
  const ids = [...present.map((block) => block.id), ...removed];
  const identities = ids.map((id) => blockIdentityForItem(doc, id));
  const hashes = uniqueHashesForIds(identities);
  return new Map(ids.map((id, index) => [frontierBlockId(id), hashes[index]]));
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
