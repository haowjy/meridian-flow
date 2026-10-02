/** Resolve and page the immutable settled prefix of an effective transcript. */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import type {
  ThreadRepositories,
  ThreadRepository,
  TranscriptKey,
  TranscriptSpan,
  TurnRepository,
} from "../ports/index.js";
import {
  ThreadConversationContextError,
  type ThreadConversationContextErrorCode,
} from "./thread-conversation-context.js";
import { CompactionPlanMetadataCodec, classifyHistoryItem } from "./turn-metadata.js";

export type TranscriptOrder = "newest_first" | "oldest_first";
export type TranscriptUnit = "item" | "turn";
export type TranscriptRange = "effective" | "inherited";

export interface TranscriptOwner {
  threadId: ThreadId;
  ref: string;
  title: string | null;
  trashed: boolean;
}

export interface TranscriptSegment {
  index: number;
  bakeId: string | null;
  openedBy: { turnId: TurnId; kind: "compaction" | "other" } | null;
  compactedThrough?: { turnId: TurnId; blockSequence?: number };
}

export interface TranscriptPage {
  entries: { turn: Turn; blocks: Block[]; ownerThreadId: ThreadId }[];
  owners: TranscriptOwner[];
  segment: TranscriptSegment;
  segmentBoundary: boolean;
  hasMore: boolean;
  nextCursor?: string;
  unsettledTail?: { turn: Turn; blocks: Block[] }[];
}

/** Internal model-projection bookkeeping, never returned by the writer read. */
export interface TranscriptProjectionPage extends TranscriptPage {
  opensSegment: boolean;
  segmentCount: number;
  /** Anchored end key even on a final page, for projections that trim it. */
  endCursor?: string;
  /** Start of the pinned prefix when the live preview consumes the output budget. */
  restartCursor?: string;
}

export interface TranscriptPageInput {
  order: TranscriptOrder;
  unit: TranscriptUnit;
  limit: number;
  cursor?: string;
  range?: TranscriptRange;
}

export interface TranscriptSpanResolution {
  spans: TranscriptSpan[];
  inheritedSpans: TranscriptSpan[];
  owners: TranscriptOwner[];
}

type TranscriptReadDeps = {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: Pick<
    TurnRepository,
    | "findById"
    | "readTranscriptItems"
    | "findFirstUnsettledTranscriptTurn"
    | "listTranscriptBoundaries"
  >;
};

const BASE64URL = /^[A-Za-z0-9_-]+$/;

interface TranscriptCursor {
  v: 1;
  t: string;
  o: TranscriptOrder;
  u: TranscriptUnit;
  r: TranscriptRange;
  a: TranscriptKey;
  k: TranscriptKey;
}

export class InvalidTranscriptCursorError extends Error {
  constructor() {
    super("Transcript cursor is invalid or does not match this read");
    this.name = "InvalidTranscriptCursorError";
  }
}

function threadContextError(
  code: ThreadConversationContextErrorCode,
  thread: Thread,
  originTurnId: string | null,
): ThreadConversationContextError {
  return new ThreadConversationContextError(code, thread.id, originTurnId);
}

function ownerFor(thread: Thread): TranscriptOwner {
  return {
    threadId: thread.id as ThreadId,
    ref: thread.ref ?? "",
    title: thread.title,
    trashed: thread.deletedAt !== null,
  };
}

function clippedSpans(spans: readonly TranscriptSpan[], throughPosition: number): TranscriptSpan[] {
  return spans.flatMap((span) => {
    const through =
      span.throughPosition === null
        ? throughPosition
        : Math.min(span.throughPosition, throughPosition);
    if (through <= span.afterPosition) return [];
    return [{ ...span, throughPosition: through }];
  });
}

/** Resolve fork prefixes without scanning any transcript rows. */
export async function resolveTranscriptSpans(
  deps: TranscriptReadDeps,
  thread: Thread,
  visiting: ReadonlySet<ThreadId> = new Set(),
): Promise<TranscriptSpanResolution> {
  const threadId = thread.id as ThreadId;
  if (visiting.has(threadId)) {
    throw threadContextError("fork_cycle", thread, thread.originTurnId ?? null);
  }
  if (thread.originType !== "fork") {
    return {
      spans: [{ threadId, afterPosition: 0, throughPosition: null }],
      inheritedSpans: [],
      owners: [ownerFor(thread)],
    };
  }

  const originTurnId = thread.originTurnId;
  if (!originTurnId) throw threadContextError("missing_cutoff_turn", thread, null);
  const cutoff = await deps.turns.findById(originTurnId as TurnId);
  if (!cutoff) throw threadContextError("missing_cutoff_turn", thread, originTurnId);
  const source = await deps.threads.findByIdIncludingDeleted(cutoff.threadId as ThreadId);
  if (!source) throw threadContextError("missing_cutoff_owner", thread, originTurnId);

  const nextVisiting = new Set(visiting);
  nextVisiting.add(threadId);
  const sourceResolution = await resolveTranscriptSpans(deps, source, nextVisiting);
  const cutoffIsEffective = sourceResolution.spans.some(
    (span) =>
      span.threadId === cutoff.threadId &&
      cutoff.position > span.afterPosition &&
      (span.throughPosition === null || cutoff.position <= span.throughPosition),
  );
  if (!cutoffIsEffective) {
    throw threadContextError("cutoff_not_in_transcript", thread, originTurnId);
  }

  const inheritedSpans = clippedSpans(sourceResolution.spans, cutoff.position);
  return {
    spans: [...inheritedSpans, { threadId, afterPosition: cutoff.position, throughPosition: null }],
    inheritedSpans,
    owners: [...sourceResolution.owners, ownerFor(thread)],
  };
}

function compareKey(left: TranscriptKey, right: TranscriptKey): number {
  return left.position - right.position || left.sequence - right.sequence;
}

function isCursorPositionConsistent(cursor: TranscriptCursor): boolean {
  if (compareKey(cursor.k, cursor.a) <= 0) return true;
  // Newest-first previews can fill a page before the settled chain starts.
  // This sentinel restarts before the anchor and is the only key above it.
  return (
    cursor.o === "newest_first" &&
    cursor.k.position === cursor.a.position + 1 &&
    cursor.k.sequence === -1
  );
}

function isKeyTuple(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    value[0] > 0 &&
    Number.isSafeInteger(value[1]) &&
    value[1] >= -1
  );
}

function isTranscriptKey(value: TranscriptKey): boolean {
  return (
    Number.isSafeInteger(value.position) &&
    value.position > 0 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= -1
  );
}

function decodeCursor(cursor: string): TranscriptCursor {
  try {
    const encoded = cursor;
    if (!BASE64URL.test(encoded)) throw new Error("invalid alphabet");
    const json = Buffer.from(encoded, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== encoded)
      throw new Error("noncanonical");
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(",") !== "a,k,o,r,t,u,v" ||
      record.v !== 1 ||
      typeof record.t !== "string" ||
      !record.t ||
      (record.o !== "newest_first" && record.o !== "oldest_first") ||
      (record.u !== "item" && record.u !== "turn") ||
      (record.r !== "effective" && record.r !== "inherited") ||
      !isKeyTuple(record.a) ||
      !isKeyTuple(record.k)
    ) {
      throw new Error("invalid fields");
    }
    return {
      v: 1,
      t: record.t,
      o: record.o,
      u: record.u,
      r: record.r,
      a: { position: record.a[0], sequence: record.a[1] },
      k: { position: record.k[0], sequence: record.k[1] },
    };
  } catch {
    throw new InvalidTranscriptCursorError();
  }
}

function encodeCursor(cursor: TranscriptCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: cursor.v,
      t: cursor.t,
      o: cursor.o,
      u: cursor.u,
      r: cursor.r,
      a: [cursor.a.position, cursor.a.sequence],
      k: [cursor.k.position, cursor.k.sequence],
    }),
  ).toString("base64url");
}

/** Re-encode a validated cursor after a consumer trims a fetched page. */
export function cursorAfter(cursor: string, key: TranscriptKey): string {
  const decoded = decodeCursor(cursor);
  if (!isTranscriptKey(key)) throw new InvalidTranscriptCursorError();
  const next = { ...decoded, k: key };
  if (!isCursorPositionConsistent(next)) throw new InvalidTranscriptCursorError();
  return encodeCursor(next);
}

function orderRows<T extends { turn: Turn; sequence: number }>(
  rows: readonly T[],
  order: TranscriptOrder,
): T[] {
  return [...rows].sort((left, right) => {
    const comparison = compareKey(
      { position: left.turn.position, sequence: left.sequence },
      { position: right.turn.position, sequence: right.sequence },
    );
    return order === "newest_first" ? -comparison : comparison;
  });
}

function groupRows(
  rows: readonly { turn: Turn; block: Block | null }[],
): TranscriptPage["entries"] {
  const byTurn = new Map<string, { turn: Turn; blocks: Block[] }>();
  for (const row of rows) {
    let entry = byTurn.get(row.turn.id);
    if (!entry) {
      entry = { turn: row.turn, blocks: [] };
      byTurn.set(row.turn.id, entry);
    }
    if (row.block) entry.blocks.push(row.block);
  }
  const entries = [...byTurn.values()].map(({ turn, blocks }) => ({
    turn,
    blocks: blocks.sort((left, right) => left.sequence - right.sequence),
    ownerThreadId: turn.threadId as ThreadId,
  }));
  entries.sort((left, right) => left.turn.position - right.turn.position);
  return entries;
}

function segmentFor(position: number, boundaries: readonly Turn[]): number {
  let index = 0;
  for (const boundary of boundaries) {
    if (boundary.position > position) break;
    index += 1;
  }
  return index;
}

function segmentHeader(
  position: number | null,
  boundaries: readonly Turn[],
  firstBakeId: string | null,
): TranscriptSegment {
  if (position === null) return { index: 0, bakeId: firstBakeId, openedBy: null };
  const opening = [...boundaries].reverse().find((turn) => turn.position <= position);
  if (!opening) return { index: 0, bakeId: firstBakeId, openedBy: null };
  const classification = classifyHistoryItem(opening);
  const kind = classification.kind === "compaction" ? "compaction" : "other";
  const metadata =
    kind === "compaction"
      ? CompactionPlanMetadataCodec.safeParse(opening.metadata)
      : CompactionPlanMetadataCodec.safeParse(null);
  return {
    index: segmentFor(position, boundaries),
    bakeId: opening.promptBakeId,
    openedBy: { turnId: opening.id as TurnId, kind },
    ...(metadata.success
      ? {
          compactedThrough: {
            turnId: metadata.data.compactedThrough.turnId as TurnId,
            ...(metadata.data.compactedThrough.blockSequence === undefined
              ? {}
              : { blockSequence: metadata.data.compactedThrough.blockSequence }),
          },
        }
      : {}),
  };
}

function turnGroups(rows: readonly { turn: Turn; block: Block | null; sequence: number }[]) {
  const grouped = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    const group = grouped.get(row.turn.id) ?? [];
    group.push(row);
    grouped.set(row.turn.id, group);
  }
  return [...grouped.values()];
}

function unsettledTail(
  rows: readonly { turn: Turn; block: Block | null; sequence: number }[],
): TranscriptPage["unsettledTail"] {
  return groupRows(rows)
    .reverse()
    .map(({ turn, blocks }) => ({ turn, blocks }));
}

async function firstPromptBakeId(
  repos: TranscriptReadDeps,
  owners: readonly TranscriptOwner[],
  thread: Thread,
): Promise<string | null> {
  const owner = owners[0];
  if (!owner) return null;
  return owner.threadId === thread.id
    ? thread.initialPromptBakeId
    : ((await repos.threads.findByIdIncludingDeleted(owner.threadId))?.initialPromptBakeId ?? null);
}

/** Writer-facing page shape; projection bookkeeping stays behind this boundary. */
export async function readTranscriptPage(
  repos: Pick<ThreadRepositories, "readSnapshot" | "threads" | "turns" | "blocks">,
  thread: Thread,
  input: TranscriptPageInput,
): Promise<TranscriptPage> {
  const {
    endCursor: _end,
    restartCursor: _restart,
    opensSegment: _opens,
    segmentCount: _count,
    ...page
  } = await readTranscriptPageForProjection(repos, thread, input);
  return page;
}

/** Reads one bounded page and, only on the first newest-first call, a marked live tail. */
export async function readTranscriptPageForProjection(
  repos: Pick<ThreadRepositories, "readSnapshot" | "threads" | "turns" | "blocks">,
  thread: Thread,
  input: TranscriptPageInput,
): Promise<TranscriptProjectionPage> {
  const range = input.range ?? "effective";
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
    throw new RangeError("Transcript page limit must be between 1 and 200");
  }
  const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
  if (
    cursor &&
    (cursor.t !== thread.id ||
      cursor.o !== input.order ||
      cursor.u !== input.unit ||
      cursor.r !== range ||
      !isCursorPositionConsistent(cursor))
  ) {
    throw new InvalidTranscriptCursorError();
  }

  return repos.readSnapshot(async () => {
    const pageThread = await repos.threads.findByIdIncludingDeleted(thread.id as ThreadId);
    if (!pageThread) throw new Error(`Thread not found: ${thread.id}`);
    const resolution = await resolveTranscriptSpans(repos, pageThread);
    const spans = range === "inherited" ? resolution.inheritedSpans : resolution.spans;
    const ownersById = new Map(resolution.owners.map((owner) => [owner.threadId, owner]));
    const owners =
      range === "inherited" && pageThread.originType !== "fork"
        ? []
        : spans.flatMap((span) => {
            const owner = ownersById.get(span.threadId);
            return owner ? [owner] : [];
          });
    const uniqueOwners = [...new Map(owners.map((owner) => [owner.threadId, owner])).values()];
    const boundaries = await repos.turns.listTranscriptBoundaries(spans);
    const firstBakeId = await firstPromptBakeId(repos, uniqueOwners, pageThread);

    if (spans.length === 0) {
      return {
        entries: [],
        owners: uniqueOwners,
        segment: segmentHeader(null, boundaries, firstBakeId),
        segmentBoundary: false,
        opensSegment: true,
        segmentCount: boundaries.length + 1,
        hasMore: false,
      };
    }

    const firstUnsettled =
      range === "inherited" ? null : await repos.turns.findFirstUnsettledTranscriptTurn(spans);
    if (cursor && firstUnsettled && cursor.a.position >= firstUnsettled.position) {
      throw new InvalidTranscriptCursorError();
    }
    const anchor =
      cursor?.a ??
      (await (async () => {
        const stableSpans = firstUnsettled
          ? clippedSpans(spans, firstUnsettled.position - 1)
          : spans;
        const [last] = await repos.turns.readTranscriptItems({
          spans: stableSpans,
          order: "newest_first",
          unit: "item",
          limit: 1,
        });
        return last ? { position: last.turn.position, sequence: last.sequence } : null;
      })());

    let tailRows: Awaited<ReturnType<typeof repos.turns.readTranscriptItems>> = [];
    if (!cursor && range === "effective" && input.order === "newest_first" && firstUnsettled) {
      const tailSpans = anchor
        ? spans.flatMap((span) => {
            const afterPosition = Math.max(span.afterPosition, anchor.position);
            return span.throughPosition !== null && span.throughPosition <= afterPosition
              ? []
              : [{ ...span, afterPosition }];
          })
        : spans;
      const candidateTail = await repos.turns.readTranscriptItems({
        spans: tailSpans,
        order: "newest_first",
        unit: input.unit,
        limit: input.limit,
      });
      tailRows =
        input.unit === "item"
          ? candidateTail.slice(0, input.limit)
          : turnGroups(candidateTail).slice(0, input.limit).flat();
    }

    const tailCount = input.unit === "item" ? tailRows.length : turnGroups(tailRows).length;
    const remaining = Math.max(0, input.limit - tailCount);
    const pageRows =
      anchor && remaining > 0
        ? await repos.turns.readTranscriptItems({
            spans,
            order: input.order,
            unit: input.unit,
            limit: remaining,
            after: cursor?.k,
            through: anchor,
          })
        : [];
    const traversalRows = orderRows(pageRows, input.order);
    const pageUnits =
      input.unit === "item" ? traversalRows.map((row) => [row]) : turnGroups(traversalRows);
    const queryMore = pageUnits.length > remaining;
    const selected = pageUnits.slice(0, remaining).flat();
    const pageSegmentIndex = selected[0]
      ? segmentFor(selected[0].turn.position, boundaries)
      : anchor
        ? segmentFor(anchor.position, boundaries)
        : 0;
    const sameSegment = selected.filter(
      (row) => segmentFor(row.turn.position, boundaries) === pageSegmentIndex,
    );
    const overflowFirst = pageUnits[remaining]?.[0];
    const segmentBoundary =
      sameSegment.length < selected.length ||
      Boolean(
        overflowFirst && segmentFor(overflowFirst.turn.position, boundaries) !== pageSegmentIndex,
      );
    const headerPosition = sameSegment[0]?.turn.position ?? anchor?.position ?? null;
    const segment = segmentHeader(headerPosition, boundaries, firstBakeId);
    const entries = groupRows(sameSegment);
    const chainHasMore =
      segmentBoundary || queryMore || (!cursor && Boolean(anchor) && remaining === 0);

    let nextCursor: string | undefined;
    if (anchor) {
      const last = sameSegment.at(-1);
      const key = last
        ? { position: last.turn.position, sequence: last.sequence }
        : input.order === "newest_first"
          ? { position: anchor.position + 1, sequence: -1 }
          : { position: anchor.position - 1, sequence: -1 };
      nextCursor = encodeCursor({
        v: 1,
        t: pageThread.id,
        o: input.order,
        u: input.unit,
        r: range,
        a: anchor,
        k: key,
      });
    }

    return {
      entries,
      ...(anchor && input.order === "newest_first"
        ? {
            restartCursor: encodeCursor({
              v: 1,
              t: pageThread.id,
              o: input.order,
              u: input.unit,
              r: range,
              a: anchor,
              k: { position: anchor.position + 1, sequence: -1 },
            }),
          }
        : {}),
      owners: uniqueOwners,
      segment,
      segmentBoundary,
      opensSegment: !cursor || segmentFor(cursor.k.position, boundaries) !== pageSegmentIndex,
      segmentCount: boundaries.length + 1,
      hasMore: chainHasMore,
      ...(nextCursor ? { endCursor: nextCursor, ...(chainHasMore ? { nextCursor } : {}) } : {}),
      ...(tailRows.length > 0 ? { unsettledTail: unsettledTail(tailRows) } : {}),
    };
  });
}

/** How many effective-transcript turns precede `position`: a turn's display number minus one. */
export async function countTranscriptTurnsBefore(
  repos: Pick<ThreadRepositories, "threads" | "turns">,
  thread: Thread,
  position: number,
): Promise<number> {
  const resolution = await resolveTranscriptSpans(repos, thread);
  return repos.turns.countTranscriptTurns(resolution.spans, position);
}

/** The Nth effective-transcript turn (from 1) with all its blocks, including the live tail. */
export async function readTranscriptTurn(
  repos: Pick<ThreadRepositories, "readSnapshot" | "threads" | "turns" | "blocks">,
  thread: Thread,
  ordinal: number,
) {
  return repos.readSnapshot(async () => {
    const resolution = await resolveTranscriptSpans(repos, thread);
    const turn = await repos.turns.findTranscriptTurnByOrdinal(resolution.spans, ordinal);
    if (!turn) return null;
    const blocks = (await repos.blocks.listByTurn(turn.id as TurnId)).sort(
      (left, right) => left.sequence - right.sequence,
    );
    const boundaries = await repos.turns.listTranscriptBoundaries(resolution.spans);
    const firstBake = await firstPromptBakeId(repos, resolution.owners, thread);
    return {
      turn,
      blocks,
      owners: resolution.owners,
      segment: segmentHeader(turn.position, boundaries, firstBake),
    };
  });
}
