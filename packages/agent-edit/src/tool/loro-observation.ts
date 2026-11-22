// What a result showed on Loro, and who changed what since the model's last read (design §5,
// "The concurrent-change report"): the frontiers say which docs changed, the docs' commit messages
// say who (`turn:<id>` a chat, anything else the writer).
import {
  type BlockId,
  type DocKey,
  freshServerPeerId,
  readDocument,
  type ShapeBlock,
  STRUCTURE_KEY,
} from "@meridian/document-model";
import type { Frontiers } from "loro-crdt";
import type { FrontierLookup } from "../frontier.js";
import {
  changedSince,
  decodeFrontierMap,
  encodeFrontierMap,
  type FrontierMap,
  messagesSince,
  planningFrontiers,
} from "../loro-frontier.js";
import { fullHashForBlockId, uniqueHashPrefixes } from "../model/block-hash.js";
import type { LoroDocument, LoroDocumentModel } from "../model/loro-model.js";
import type { ProjectedBlock } from "../ports/model.js";
import type { InternalWriteResult } from "./internal-result.js";
import type { AgentEditConcurrentGroup, AgentEditModelPayload } from "./model-result.js";

export interface LoroListingSource {
  /** The room copy the result rendered from, the call's own write merged in. */
  copy: LoroDocument;
  model: LoroDocumentModel;
  room: string;
  recording?: FrontierLookup;
  /** The reader's own turn: its changes are not listed. */
  ownTurn: string | null;
  /** Blocks the result's own write removed. */
  ownRemoved: ReadonlySet<string>;
  projected: readonly ProjectedBlock[];
  authorOfTurn?(turnId: string): Promise<string | null>;
  onFailed(cause: unknown): void;
}

/**
 * The result with the frontier it showed and, when the model read this room before, the blocks
 * others changed since that read, by author. Never fails the result: a failure goes out without it.
 */
export async function recordLoroObservation(
  result: InternalWriteResult,
  source: LoroListingSource,
): Promise<InternalWriteResult> {
  if (!source.recording) return result;
  try {
    const prev = await source.recording(source.room);
    const frontier = {
      room: source.room,
      snapshot: encodeFrontierMap(source.copy.docs.frontiers()),
    };
    const recorded = prev?.room === source.room ? decodeFrontierMap(prev.snapshot) : null;
    const groups = recorded ? await listing(source, recorded, result.model) : [];
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
  payload: AgentEditModelPayload | undefined,
): Promise<AgentEditConcurrentGroup[]> {
  const { copy } = source;
  const docs = copy.docs;
  // A read below the cutoff, or of docs this copy no longer has, has no comparable cut.
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
    for (const message of messagesSince(doc, from)) {
      const label = await labelOf(source, message, labels);
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

  const shown = shownInFull(source.projected, payload);
  const hashes = hashesFor([...top.map((block) => block.id), ...removedIds]);
  const groups: AgentEditConcurrentGroup[] = [];
  for (const [author, changes] of byAuthor) {
    const group: AgentEditConcurrentGroup = { author };
    for (const id of changes.changed) {
      const hash = hashes.get(id) as string;
      if (shown.has(id)) group.shown = [...(group.shown ?? []), hash];
      else group.other = [...(group.other ?? []), hash];
    }
    for (const id of changes.removed)
      group.removed = [...(group.removed ?? []), hashes.get(id) as string];
    for (const id of changes.overwritten)
      group.overwritten = [...(group.overwritten ?? []), fullHashForBlockId(id).slice(0, 4)];
    if (group.shown || group.other || group.removed || group.overwritten) groups.push(group);
  }
  return groups;
}

/** Who a commit message names: null for the reader's own turn. */
async function labelOf(
  source: LoroListingSource,
  message: string | undefined,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (!message?.startsWith("turn:")) return "the user";
  const turn = message.slice("turn:".length);
  if (turn === source.ownTurn) return null;
  let label = cache.get(turn);
  if (label === undefined) {
    label = (await source.authorOfTurn?.(turn)) ?? "another agent";
    cache.set(turn, label);
  }
  return label;
}

/**
 * Top-level blocks whose structure changed between two reads: new, retyped, re-attributed, a
 * nested block added, removed, moved or retyped, or moved among the blocks both reads show.
 */
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

function shownInFull(
  projected: readonly ProjectedBlock[],
  payload: AgentEditModelPayload | undefined,
): Set<BlockId> {
  if (payload?.read?.format === "outline" || payload?.awarenessDegraded) return new Set();
  const hashes = new Set(
    (payload?.blocks ?? []).flatMap((group) =>
      group.extent === "full" ? group.items.map((item) => item.hash) : [],
    ),
  );
  return new Set(projected.filter((block) => hashes.has(block.hash)).map((block) => block.key));
}

function hashesFor(ids: readonly BlockId[]): Map<BlockId, string> {
  const prefixes = uniqueHashPrefixes(ids.map(fullHashForBlockId));
  return new Map(ids.map((id, index) => [id, prefixes[index]]));
}
