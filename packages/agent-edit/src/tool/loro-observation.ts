// What a result showed on Loro, and who changed what since the model's last read (design §5,
// "The concurrent-change report"): the frontiers say which docs changed, the docs' commit messages
// say who (`readCommitMessage`: a chat's turn, the writer's Apply or Discard, or else the writer).

import { type DocumentRoom, loroRoomName } from "@meridian/contracts/protocol";
import {
  type BlockId,
  type CommitAuthor,
  type DocKey,
  freshServerPeerId,
  readDocument,
  type ShapeBlock,
  STRUCTURE_KEY,
} from "@meridian/document-model";
import type { Frontiers } from "loro-crdt";
import type { FrontierLookup } from "../frontier.js";
import {
  authorsSince,
  changedSince,
  encodeFrontierMap,
  type FrontierMap,
  latestRead,
  planningFrontiers,
} from "../loro-frontier.js";
import { fullHashForBlockId, uniqueHashPrefixes } from "../model/block-hash.js";
import type { LoroDocument, LoroDocumentModel } from "../model/loro-model.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditConcurrentGroup } from "./model-result.js";

export interface LoroListingSource {
  copy: LoroDocument;
  model: LoroDocumentModel;
  room: DocumentRoom;
  documentId: string;
  recording?: FrontierLookup;
  ownTurn: string | null;
  ownRemoved: ReadonlySet<string>;
  authorOfTurn?(turnId: string): Promise<string | null>;
  onFailed(cause: unknown): void;
}

export async function recordLoroObservation(
  result: InternalWriteResult,
  source: LoroListingSource,
): Promise<InternalWriteResult> {
  if (!source.recording) return result;
  try {
    const recorded = await latestRead(source.recording, source.documentId);
    const frontier = {
      room: loroRoomName(source.room),
      snapshot: encodeFrontierMap(source.copy.docs.frontiers()),
    };
    const groups = recorded ? await listing(source, recorded) : [];
    return groups.length
      ? { ...result, frontier, model: { ...result.model, concurrent: { groups } } }
      : { ...result, frontier };
  } catch (cause) {
    source.onFailed(cause);
    return result;
  }
}

type Changes = { changed: Set<BlockId>; removed: Set<BlockId>; overwritten: Set<BlockId> };

async function listing(
  source: LoroListingSource,
  recorded: FrontierMap,
): Promise<AgentEditConcurrentGroup[]> {
  const { copy } = source;
  const docs = copy.docs;
  if (!planningFrontiers(docs, recorded, [])) return [];
  const changedKeys = changedSince(docs, recorded);
  if (changedKeys.size === 0) return [];

  const top = copy.top();
  const topOf = new Map<BlockId, BlockId>();
  const walk = (block: ShapeBlock, root: BlockId) => {
    topOf.set(block.id, root);
    if (block.kind === "container") for (const child of block.children) walk(child, root);
  };
  for (const block of top) walk(block, block.id);

  const byAuthor = new Map<string, Changes>();
  const labels = new Map<string, string | null>();
  const authorsOf = async (key: DocKey, from: Frontiers | undefined): Promise<Set<string>> => {
    const doc = key === STRUCTURE_KEY ? docs.structure : docs.textOf(key);
    const out = new Set<string>();
    if (!doc) return out;
    for (const by of authorsSince(doc, from)) {
      const label = await labelOf(source, by, labels);
      if (label) out.add(label);
    }
    return out;
  };
  const note = (authors: Set<string>, kind: keyof Changes, id: BlockId) => {
    for (const author of authors) {
      const changes = byAuthor.get(author) ?? {
        changed: new Set(),
        removed: new Set(),
        overwritten: new Set(),
      };
      changes[kind].add(id);
      byAuthor.set(author, changes);
    }
  };

  for (const key of changedKeys) {
    if (key === STRUCTURE_KEY) continue;
    const authors = await authorsOf(key, recorded.get(key));
    if (authors.size === 0) continue;
    const root = topOf.get(key);
    if (root) note(authors, "changed", root);
    else if (source.ownRemoved.has(key)) note(authors, "overwritten", key);
  }

  const removedIds: BlockId[] = [];
  if (changedKeys.has(STRUCTURE_KEY)) {
    const authors = await authorsOf(STRUCTURE_KEY, recorded.get(STRUCTURE_KEY));
    if (authors.size > 0) {
      const then = docs.at(
        new Map([[STRUCTURE_KEY, recorded.get(STRUCTURE_KEY) ?? []]]),
        freshServerPeerId(),
      );
      let before: readonly ShapeBlock[];
      try {
        before = readDocument(then);
      } finally {
        then.free();
      }
      for (const id of structurallyChanged(before, top)) note(authors, "changed", id);
      const now = new Set(top.map((block) => block.id));
      for (const block of before)
        if (!now.has(block.id) && !source.ownRemoved.has(block.id)) {
          note(authors, "removed", block.id);
          removedIds.push(block.id);
        }
    }
  }
  if (byAuthor.size === 0) return [];

  const hashes = hashesFor([...top.map((block) => block.id), ...removedIds]);
  const groups: AgentEditConcurrentGroup[] = [];
  for (const [author, changes] of byAuthor) {
    const group: AgentEditConcurrentGroup = { author };
    for (const id of changes.changed) {
      const hash = hashes.get(id) as string;
      group.changed = [...(group.changed ?? []), hash];
    }
    for (const id of changes.removed)
      group.removed = [...(group.removed ?? []), hashes.get(id) as string];
    for (const id of changes.overwritten)
      group.overwritten = [...(group.overwritten ?? []), fullHashForBlockId(id).slice(0, 4)];
    if (group.changed || group.removed || group.overwritten) groups.push(group);
  }
  return groups;
}

async function labelOf(
  source: LoroListingSource,
  by: CommitAuthor | undefined,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!by) return "the user";
  if (!("turn" in by)) return "the user's Apply or Discard";
  const { turn } = by;
  if (turn === source.ownTurn) return null;
  let label = cache.get(turn);
  if (label === undefined) {
    label = (await source.authorOfTurn?.(turn)) ?? "another agent";
    cache.set(turn, label);
  }
  return label;
}

function structurallyChanged(
  before: readonly ShapeBlock[],
  after: readonly ShapeBlock[],
): BlockId[] {
  const signature = (block: ShapeBlock): string =>
    JSON.stringify([
      block.node,
      block.attrs,
      block.kind === "container" ? block.children.map((child) => [child.id, signature(child)]) : [],
    ]);
  const then = new Map(before.map((block) => [block.id, signature(block)]));
  const common = new Set(after.filter((block) => then.has(block.id)).map((block) => block.id));
  const previousOf = (blocks: readonly ShapeBlock[]) => {
    const out = new Map<BlockId, BlockId | null>();
    let last: BlockId | null = null;
    for (const block of blocks) {
      if (!common.has(block.id)) continue;
      out.set(block.id, last);
      last = block.id;
    }
    return out;
  };
  const prevThen = previousOf(before);
  const prevNow = previousOf(after);
  return after
    .filter(
      (block) =>
        then.get(block.id) !== signature(block) ||
        (common.has(block.id) && prevThen.get(block.id) !== prevNow.get(block.id)),
    )
    .map((block) => block.id);
}

function hashesFor(ids: readonly BlockId[]): Map<BlockId, string> {
  const prefixes = uniqueHashPrefixes(ids.map(fullHashForBlockId));
  return new Map(ids.map((id, index) => [id, prefixes[index]]));
}
