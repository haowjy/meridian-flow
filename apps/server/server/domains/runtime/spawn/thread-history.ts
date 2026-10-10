/**
 * `thread_history`: a page of numbered turns, one expanded turn, or one item in
 * full, projected to `HistoryResult` over the shared effective-transcript reader.
 */

import { createHash } from "node:crypto";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { SavedExecutionReport } from "@meridian/contracts/spawn";
import {
  type Block,
  isTerminalTurnStatus,
  type Thread,
  type Turn,
} from "@meridian/contracts/threads";
import { z } from "zod";
import {
  countConversationTurnsBefore,
  cursorAfter,
  InvalidTranscriptCursorError,
  readTranscriptPageForProjection,
  readTranscriptTurn,
} from "../../threads/index.js";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";
import type { TokenizerFamily } from "../gateway/index.js";
import { estimateModelPartTokens } from "../loop/compaction/estimate.js";
import type { ToolRegistry } from "../tools/types.js";
import { shortenCallArgs } from "./history-call-line.js";
import {
  type DescribedBlock,
  describeBlock,
  describeTurn,
  displayIndexes,
  editEvidence,
  editRecord,
  type HistoryInclude,
  historyTime,
  loadHistoryToolPairs,
  toolPairMap,
} from "./history-item.js";
import {
  type HistoryItem,
  type HistoryResult,
  type HistoryTurn,
  reportContent,
  type SavedReportView,
} from "./history-result.js";
import { resolveReadableThread, threadReadError } from "./resolve-readable-thread.js";

const INCLUDES = [
  "routine_calls",
  "tool_results",
  "thinking",
  "system_messages",
  "system_prompt",
  "timestamps",
] as const satisfies readonly HistoryInclude[];

const EXPAND_FORMAT = 'expected a turn number such as 4, or "4.7"';

export const ThreadHistoryInputSchema = z
  .object({
    ref: z
      .string()
      .min(1)
      .describe('Conversation ref such as c3 or p12, or "current"; omit for this conversation.')
      .optional(),
    order: z.enum(["newest_first", "oldest_first"]).default("newest_first"),
    cursor: z.string().min(1).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(40)
      .describe("Turns per page. Hidden calls don't count."),
    include: z
      .array(z.enum(INCLUDES))
      .describe(
        "Detail hidden by default. routine_calls: show hidden inspection calls (`read`, `ls`, `search` and the like) as one-line entries. tool_results: add results to visible tool calls. thinking: show thinking. system_messages, system_prompt: show system messages, or the system prompt. timestamps: show when each turn happened.",
      )
      .optional(),
    expand: z
      .union([z.number().int().min(1), z.string().regex(/^\d+(\.\d+)?$/u, EXPAND_FORMAT)], {
        error: EXPAND_FORMAT,
      })
      .describe(
        'A turn number such as 4 for that turn in full, or "4.7" for its item 7. Use the handles history prints.',
      )
      .optional(),
  })
  .strict();
export type ThreadHistoryInput = z.input<typeof ThreadHistoryInputSchema>;

/** A single message or result on a page. */
const ITEM_TOKENS = 2000;
const PAGE_TOKENS = 8000;
/** One expanded turn or item. */
const EXPAND_TOKENS = 16000;
const REPORT_LINES = 20;
const SCAN_ROWS = 2000;
const DEFAULT_LIMIT = 40;

type CursorKey = { position: number; sequence: number };
const cursorKeyText = (key: CursorKey) =>
  `${key.position}${key.sequence === -1 ? "" : `.${key.sequence}`}`;
const cursorTag = (threadId: string, body: string) =>
  createHash("sha256").update(`${threadId}:${body}`).digest("hex").slice(0, 8);

function internalHistoryCursor(
  cursor: string,
  target: Thread,
  order: "newest_first" | "oldest_first",
): string | { ok: false; error: ReturnType<typeof threadReadError>["error"] } {
  const match = /^(c\d+|p\d+):([no])(\d+)(?:\.(\d+))?@(\d+)(?:\.(\d+))?~([a-f0-9]{8})$/u.exec(
    cursor,
  );
  if (!match) return threadReadError("invalid_cursor", "Invalid history cursor");
  if (match[1] !== target.ref)
    return threadReadError("invalid_cursor", "Cursor belongs to another conversation");
  const cursorOrder = match[2] === "n" ? "newest_first" : "oldest_first";
  if (cursorOrder !== order)
    return threadReadError("invalid_cursor", "Cursor belongs to another history order");
  const body = cursor.slice(0, cursor.lastIndexOf("~"));
  if (match[7] !== cursorTag(target.id, body))
    return threadReadError("invalid_cursor", "Cursor anchor does not match");
  return Buffer.from(
    JSON.stringify({
      v: 1,
      t: target.id,
      o: order,
      u: "item",
      r: "effective",
      a: [Number(match[5]), match[6] === undefined ? -1 : Number(match[6])],
      k: [Number(match[3]), match[4] === undefined ? -1 : Number(match[4])],
    }),
  ).toString("base64url");
}

function modelHistoryCursor(cursor: string, ref: string): string {
  const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
    t: string;
    o: "newest_first" | "oldest_first";
    a: [number, number];
    k: [number, number];
  };
  const body = `${ref}:${value.o === "newest_first" ? "n" : "o"}${cursorKeyText({ position: value.k[0], sequence: value.k[1] })}@${cursorKeyText({ position: value.a[0], sequence: value.a[1] })}`;
  return `${body}~${cursorTag(value.t, body)}`;
}

function capper(tokenizer: TokenizerFamily) {
  const tokens = (value: string) =>
    estimateModelPartTokens({ type: "text", text: value }, tokenizer);
  /** The longest prefix of `text` within `budget` tokens. */
  const cap = (text: string, budget: number): { text: string; truncated: boolean } => {
    if (tokens(text) <= budget) return { text, truncated: false };
    const chars = Array.from(text);
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (tokens(chars.slice(0, mid).join("")) <= budget) lo = mid;
      else hi = mid - 1;
    }
    return { text: chars.slice(0, lo).join(""), truncated: true };
  };
  return { tokens, cap };
}

function reportView(report: SavedExecutionReport, lines?: number): SavedReportView | undefined {
  if (report.outcome === null) return undefined;
  const content = reportContent(report.summary, report.payload, report.artifacts);
  const kept = lines === undefined ? content : content.split("\n").slice(0, lines).join("\n");
  return {
    outcome: report.outcome,
    source: report.source,
    reason: report.reason,
    partial: report.outcome !== "succeeded",
    content: kept,
    ...(kept !== content ? { truncated: true as const } : {}),
  };
}

async function reportsByTurn(
  repos: Pick<ThreadRepositories, "executionReports">,
  target: Thread,
): Promise<ReadonlyMap<string, SavedExecutionReport>> {
  if (target.kind !== "subagent") return new Map();
  const reports = await repos.executionReports.listFinishedByChild(target.id as ThreadId);
  return new Map(
    reports.flatMap((report) =>
      report.terminalTurnId ? [[report.terminalTurnId as string, report] as const] : [],
    ),
  );
}

type Tool = Extract<DescribedBlock, { kind: "tool" }>;
const toolState = (
  described: Tool,
  live: boolean,
): Extract<HistoryItem, { kind: "tool" }>["state"] =>
  described.isError ? "error" : described.open ? (live ? "running" : "cancelled") : "done";

/** A call's one-line form (D48): its shortened arguments, state and summary. */
const callItem = (described: Tool, live: boolean) => ({
  kind: "tool" as const,
  tool: described.tool,
  args: described.withheld ? null : shortenCallArgs(described.tool, described.args),
  state: toolState(described, live),
  ...(described.summary ? { summary: described.summary } : {}),
});

/** A shown write line quotes its edit inputs, so it carries edit evidence for compaction. */
const lineEvidence = (described: Tool) =>
  described.write && !described.withheld ? editEvidence(described) : [];

interface Projection {
  repos: ThreadRepositories;
  registry: ToolRegistry;
  target: Thread;
  include: ReadonlySet<HistoryInclude>;
  tokenizer: TokenizerFamily;
}

export async function readThreadHistory(input: {
  repos: ThreadRepositories;
  registry: ToolRegistry;
  caller: Thread;
  input: ThreadHistoryInput;
  tokenizer: TokenizerFamily;
}) {
  const { repos, caller } = input;
  return repos.readSnapshot(async () => {
    const resolved = await resolveReadableThread({
      caller,
      ref: input.input.ref,
      threads: repos.threads,
      turns: repos.turns,
    });
    if (!resolved.ok) return resolved;
    const projection: Projection = {
      repos,
      registry: input.registry,
      target: resolved.target,
      include: new Set(input.input.include ?? []),
      tokenizer: input.tokenizer,
    };
    if (input.input.expand !== undefined) return expandHistory(projection, input.input.expand);
    return readHistoryPage(projection, input.input);
  });
}

/** What one transcript row adds to its turn on a page. */
interface RowPart {
  item?: HistoryItem;
  hidden?: true;
  report?: SavedReportView;
  docs?: DocumentRevisionEvidence[];
}
type Row = { turn: Turn; block: Block | null; live: boolean };

/** One turn as it accumulates on a page; numbered once the walk ends. */
interface PageTurn {
  turn: Turn;
  heading: ReturnType<typeof describeTurn>;
  from?: string;
  live: boolean;
  shown: boolean;
  items: { sequence: number; item: HistoryItem }[];
  hiddenCount: number;
  report?: SavedReportView;
}

async function readHistoryPage(p: Projection, input: ThreadHistoryInput) {
  const { repos, target, include } = p;
  const { tokens, cap } = capper(p.tokenizer);
  const order = input.order ?? "newest_first";
  const limit = input.limit ?? DEFAULT_LIMIT;
  const reports = await reportsByTurn(repos, target);
  const turnBlocks = new Map<string, Promise<Block[]>>();
  const blocksOf = (turn: Turn) => {
    let loaded = turnBlocks.get(turn.id);
    if (!loaded) {
      loaded = repos.blocks.listByTurn(turn.id as TurnId);
      turnBlocks.set(turn.id, loaded);
    }
    return loaded;
  };
  const turns = new Map<string, PageTurn>();
  const documents: DocumentRevisionEvidence[] = [];
  let used = tokens(`Conversation ${target.ref}`) + 300;
  let shownTurns = 0;
  let systemPrompt: string | undefined;
  let segment: Awaited<ReturnType<typeof readTranscriptPageForProjection>>["segment"] | undefined;

  const requestedCursor = input.cursor
    ? internalHistoryCursor(input.cursor, target, order)
    : undefined;
  if (requestedCursor && typeof requestedCursor !== "string") return requestedCursor;
  let next = requestedCursor;
  let stopped = false;
  let consumedSettled = false;
  let scanned = 0;

  /** What one row adds to its turn on this page, or null when it adds nothing. */
  async function contribution(
    entry: PageTurn,
    block: Block | null,
    toolPairs: ReadonlyMap<string, Block>,
  ): Promise<RowPart | null> {
    const part = await rowPart(entry, block, toolPairs);
    // A failed or cancelled turn shows its status even when every row is hidden.
    return part ?? (entry.heading.failure && !entry.shown && !hiddenTurn(entry) ? {} : null);
  }

  const hiddenTurn = (entry: PageTurn) => entry.heading.system && !include.has("system_messages");

  async function rowPart(
    entry: PageTurn,
    block: Block | null,
    toolPairs: ReadonlyMap<string, Block>,
  ): Promise<RowPart | null> {
    const saved = reports.get(entry.turn.id);
    const report =
      saved && (await isLastRow(entry.turn, block)) ? reportView(saved, REPORT_LINES) : undefined;
    if (hiddenTurn(entry)) return null;
    const withReport = (value: RowPart): RowPart => (report ? { ...value, report } : value);
    if (!block) return report ? { report } : null;
    const described = describeBlock({ turn: entry.turn, block, registry: p.registry, toolPairs });
    switch (described.kind) {
      case "merged":
        return report ? { report } : null;
      case "thinking": {
        if (!include.has("thinking")) return report ? { report } : null;
        const capped = cap(described.text, ITEM_TOKENS);
        return withReport({
          item: {
            kind: "thinking",
            text: capped.text,
            tokens: tokens(described.text),
            ...(capped.truncated ? { truncated: true as const } : {}),
          },
        });
      }
      case "system": {
        if (!include.has("system_messages")) return report ? { report } : null;
        const capped = cap(described.text, ITEM_TOKENS);
        return withReport({
          item: {
            kind: "system",
            label: described.label,
            text: capped.text,
            tokens: tokens(described.text),
            ...(capped.truncated ? { truncated: true as const } : {}),
          },
        });
      }
      case "message": {
        const capped = cap(described.text, ITEM_TOKENS);
        return withReport({
          item: {
            kind: "message",
            text: capped.text,
            tokens: tokens(described.text),
            ...(capped.truncated ? { truncated: true as const } : {}),
          },
        });
      }
      case "tool": {
        const state = toolState(described, entry.live);
        if (described.routine && state === "done" && !include.has("routine_calls"))
          return withReport({ hidden: true as const });
        const result =
          described.result !== undefined && (include.has("tool_results") || state === "error")
            ? cap(described.result, ITEM_TOKENS)
            : undefined;
        const docs = lineEvidence(described);
        return withReport({
          item: {
            ...callItem(described, entry.live),
            ...(result ? { result: result.text } : {}),
            ...(result?.truncated ? { truncated: true as const } : {}),
          },
          ...(docs.length ? { docs } : {}),
        });
      }
    }
  }

  /** A saved report renders once, on the page holding its turn's last row. */
  async function isLastRow(turn: Turn, block: Block | null) {
    if (!block) return true;
    const blocks = await blocksOf(turn);
    return block.sequence === Math.max(...blocks.map((candidate) => candidate.sequence));
  }

  function costOf(entry: PageTurn, part: RowPart) {
    let cost = 0;
    if (!entry.shown) cost += 10 + (entry.heading.failure ? 30 : 0);
    if (part.item) cost += tokens(JSON.stringify(part.item)) + 5;
    if (part.hidden && entry.hiddenCount === 0) cost += 30;
    if (part.report) cost += tokens(part.report.content) + 20;
    return cost;
  }

  try {
    do {
      const page = await readTranscriptPageForProjection(repos, target, {
        order,
        unit: "item",
        limit: 200,
        ...(next ? { cursor: next } : {}),
      });
      if (!segment) {
        segment = page.segment;
        if (include.has("system_prompt") && page.opensSegment && page.segment.bakeId) {
          const bake = await repos.promptBakes.findById(page.segment.bakeId);
          if (bake) {
            const capped = cap(bake.composedSystemPrompt, 4000);
            systemPrompt = `${capped.text}${capped.truncated ? "\n[prompt truncated]" : ""}`;
            used += tokens(systemPrompt);
          }
        }
      }
      const rows = page.entries.flatMap<Row>((entry) =>
        entry.blocks.length
          ? entry.blocks.map((block) => ({ turn: entry.turn, block, live: false }))
          : [{ turn: entry.turn, block: null, live: false }],
      );
      scanned += rows.length;
      if (order === "newest_first") rows.reverse();
      // The live tail reads chronologically and is never part of the cursor.
      const tail = (page.unsettledTail ?? [])
        .slice()
        .sort((left, right) => left.turn.position - right.turn.position)
        .flatMap<Row>((entry) =>
          entry.blocks.length
            ? entry.blocks.map((block) => ({ turn: entry.turn, block, live: true }))
            : [{ turn: entry.turn, block: null, live: true }],
        );
      const toolPairs = await loadHistoryToolPairs(repos.blocks, [...tail, ...rows]);
      for (const row of [...tail, ...rows]) {
        let entry = turns.get(row.turn.id);
        const fresh = !entry;
        entry ??= {
          turn: row.turn,
          heading: describeTurn(row.turn),
          ...(row.turn.threadId !== target.id
            ? { from: page.owners.find((owner) => owner.threadId === row.turn.threadId)?.ref }
            : {}),
          live: row.live,
          shown: false,
          items: [],
          hiddenCount: 0,
        };
        const part = await contribution(entry, row.block, toolPairs);
        if (part) {
          if (!entry.shown && shownTurns >= limit) {
            stopped = true;
            break;
          }
          const cost = costOf(entry, part);
          if (used + cost > PAGE_TOKENS && (shownTurns > 0 || entry.shown)) {
            stopped = true;
            break;
          }
          used += cost;
          if (!entry.shown) shownTurns += 1;
          entry.shown = true;
          if (part.item) entry.items.push({ sequence: row.block?.sequence ?? -1, item: part.item });
          if (part.hidden) entry.hiddenCount += 1;
          if (part.report) entry.report = part.report;
          if (part.docs) documents.push(...part.docs);
        }
        if (fresh) turns.set(row.turn.id, entry);
        if (!row.live) {
          consumedSettled = true;
          if (page.endCursor)
            next = cursorAfter(page.endCursor, {
              position: row.turn.position,
              sequence: row.block?.sequence ?? -1,
            });
        }
      }
      if (stopped) {
        // A live preview has no chain key. Its restart cursor begins at the settled prefix.
        if (!consumedSettled) next = page.restartCursor;
        break;
      }
      next = page.nextCursor;
      if (page.segmentBoundary || scanned >= SCAN_ROWS) break;
    } while (next);
  } catch (error) {
    if (error instanceof InvalidTranscriptCursorError)
      return threadReadError("invalid_cursor", error.message);
    throw error;
  }

  // Numbers count conversation turns only (isConversationTurn, the same rule as the
  // repository count); the walk covered a contiguous run, so they continue from the base.
  const walked = [...turns.values()].sort(
    (left, right) => left.turn.position - right.turn.position,
  );
  const first = walked[0];
  let counted = first ? await countConversationTurnsBefore(repos, target, first.turn.position) : 0;
  const opener =
    segment?.openedBy?.kind === "compaction"
      ? walked.find((entry) => entry.turn.id === segment?.openedBy?.turnId)
      : undefined;
  let marked = false;
  const settled: HistoryTurn[] = [];
  const inProgress: HistoryTurn[] = [];
  for (const entry of walked) {
    const number = entry.heading.system ? undefined : ++counted;
    if (!entry.shown) continue;
    const items = entry.items.sort((left, right) => left.sequence - right.sequence);
    if (items.some(({ item }) => item.truncated)) {
      const indexes = displayIndexes(await blocksOf(entry.turn));
      for (const { sequence, item } of items)
        if (item.truncated) item.index = indexes.get(sequence);
    }
    const summarizedBefore =
      !marked && !entry.live && opener !== undefined && entry.turn.position >= opener.turn.position;
    if (summarizedBefore) marked = true;
    (entry.live ? inProgress : settled).push({
      ...(number !== undefined ? { number } : {}),
      role: entry.heading.role,
      label: entry.heading.label,
      ...(entry.from ? { from: entry.from } : {}),
      ...(include.has("timestamps") ? { at: historyTime(entry.turn) } : {}),
      items: items.map(({ item }) => item),
      hiddenCount: entry.hiddenCount,
      ...(entry.report ? { report: entry.report } : {}),
      ...(summarizedBefore ? { summarizedBefore: true } : {}),
      ...(entry.heading.failure ? { failure: entry.heading.failure } : {}),
    });
  }
  const ref = target.ref as string;
  const result: HistoryResult = {
    ref,
    view: "page",
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    turns: settled,
    inProgress,
    ...(next
      ? {
          next: {
            call: {
              ref,
              ...(order !== "newest_first" ? { order } : {}),
              cursor: modelHistoryCursor(next, ref),
              ...(limit !== DEFAULT_LIMIT ? { limit } : {}),
              ...(input.include !== undefined ? { include: input.include } : {}),
            },
          },
        }
      : {}),
  };
  return { output: result, metadata: { documentRevisions: uniqueDocuments(documents) } };
}

function uniqueDocuments(documents: readonly DocumentRevisionEvidence[]) {
  return [...new Map(documents.map((ref) => [ref.documentId, ref])).values()];
}

/** `expand: N` lists every item of turn N on one line; `expand: "N.k"` shows item k in full. */
async function expandHistory(p: Projection, expand: number | string) {
  const { repos, target } = p;
  const { tokens, cap } = capper(p.tokenizer);
  const [turnPart, itemPart] = String(expand).split(".");
  const number = Number(turnPart);
  if (!Number.isSafeInteger(number) || number < 1)
    return threadReadError("item_not_found", "Invalid item handle");
  const found = await readTranscriptTurn(repos, target, number);
  if (!found) return threadReadError("item_not_found", `Turn ${number} not found in ${target.ref}`);
  const { turn, blocks } = found;
  const heading = describeTurn(turn);
  const live = !isTerminalTurnStatus(turn.status);
  const toolPairs = toolPairMap(blocks);
  const indexes = displayIndexes(blocks);
  const described = blocks.flatMap((block) => {
    const item = describeBlock({ turn, block, registry: p.registry, toolPairs });
    const index = indexes.get(block.sequence);
    return item.kind === "merged" || index === undefined ? [] : [{ index, item }];
  });
  const ownerRef =
    turn.threadId !== target.id
      ? found.owners.find((owner) => owner.threadId === turn.threadId)?.ref
      : undefined;
  const historyTurn = (items: HistoryItem[], report?: SavedReportView): HistoryTurn => ({
    number,
    role: heading.role,
    label: heading.label,
    ...(ownerRef ? { from: ownerRef } : {}),
    ...(p.include.has("timestamps") ? { at: historyTime(turn) } : {}),
    items,
    hiddenCount: 0,
    ...(report ? { report } : {}),
    ...(heading.failure ? { failure: heading.failure } : {}),
  });
  const ref = target.ref as string;
  let budget = EXPAND_TOKENS - 200;

  if (itemPart !== undefined) {
    const k = Number(itemPart);
    const match = described.find((entry) => entry.index === k);
    if (!match)
      return threadReadError("item_not_found", `Item ${number}.${itemPart} not found in ${ref}`);
    const { item } = match;
    let full: HistoryItem;
    const docs: DocumentRevisionEvidence[] = [];
    if (item.kind === "tool") {
      if (item.write) docs.push(...editEvidence(item));
      const args = cap(
        item.write ? editRecord(turn, item.args) : JSON.stringify(item.args),
        budget,
      );
      budget -= tokens(args.text);
      const result = item.result !== undefined ? cap(item.result, Math.max(budget, 0)) : undefined;
      full = {
        ...callItem(item, live),
        index: k,
        ...(item.rawResult !== undefined ? { resultTokens: tokens(item.rawResult) } : {}),
        fullArgs: args.text,
        ...(result ? { result: result.text } : {}),
        ...(args.truncated || result?.truncated ? { truncated: true as const } : {}),
      };
    } else {
      const capped = cap(item.text, budget);
      full = {
        ...(item.kind === "system" ? { kind: "system", label: item.label } : { kind: item.kind }),
        index: k,
        text: capped.text,
        tokens: tokens(item.text),
        ...(capped.truncated ? { truncated: true as const } : {}),
      } as HistoryItem;
    }
    const result: HistoryResult = {
      ref,
      view: "item",
      turns: [historyTurn([full])],
      inProgress: [],
    };
    return { output: result, metadata: { documentRevisions: uniqueDocuments(docs) } };
  }

  const docs: DocumentRevisionEvidence[] = [];
  const items: HistoryItem[] = described.map(({ index, item }) => {
    if (item.kind === "tool") {
      const line = {
        ...callItem(item, live),
        index,
        ...(item.rawResult !== undefined ? { resultTokens: tokens(item.rawResult) } : {}),
      };
      budget -= tokens(JSON.stringify(line)) + 5;
      docs.push(...lineEvidence(item));
      return line;
    }
    const size = tokens(item.text);
    // Messages show in full up to the item cap while the expansion budget lasts; then one line each.
    if (item.kind === "thinking" || budget < Math.min(size, ITEM_TOKENS)) {
      budget -= 20;
      return {
        ...(item.kind === "system" ? { kind: "system", label: item.label } : { kind: item.kind }),
        index,
        tokens: size,
      } as HistoryItem;
    }
    const capped = cap(item.text, ITEM_TOKENS);
    budget -= tokens(capped.text) + 10;
    return {
      ...(item.kind === "system" ? { kind: "system", label: item.label } : { kind: item.kind }),
      index,
      text: capped.text,
      tokens: size,
      ...(capped.truncated ? { truncated: true as const } : {}),
    } as HistoryItem;
  });
  const saved = (await reportsByTurn(repos, target)).get(turn.id);
  let report = saved ? reportView(saved) : undefined;
  if (report) {
    const capped = cap(report.content, Math.max(budget, 200));
    report = {
      ...report,
      content: `${capped.text}${capped.truncated ? "\n[report truncated at expansion limit]" : ""}`,
    };
  }
  const result: HistoryResult = {
    ref,
    view: "turn",
    turns: [historyTurn(items, report)],
    inProgress: [],
  };
  return { output: result, metadata: { documentRevisions: uniqueDocuments(docs) } };
}
