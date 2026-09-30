/** Bounded, segmented model history over the shared effective-transcript reader. */

import { createHash } from "node:crypto";
import type { DocumentRevisionEvidence } from "@meridian/contracts/protocol";
import type { Block, Thread, Turn } from "@meridian/contracts/threads";
import { z } from "zod";
import type { TranscriptSegment } from "../../threads/domain/transcript-page.js";
import {
  cursorAfter,
  InvalidTranscriptCursorError,
  readTranscriptItem,
  readTranscriptPageForProjection,
} from "../../threads/index.js";
import type { ThreadRepositories } from "../../threads/ports/repositories.js";
import type { TokenizerFamily } from "../gateway/index.js";
import { estimateModelPartTokens } from "../loop/compaction/estimate.js";
import type { ToolRegistry } from "../tools/types.js";
import {
  type HistoryInclude,
  type HistoryItem,
  loadHistoryToolPairs,
  renderHistoryItem,
} from "./history-item.js";
import { resolveReadableThread, threadReadError } from "./resolve-readable-thread.js";
export const ThreadHistoryInputSchema = z
  .object({
    ref: z
      .string()
      .describe("Conversation ref such as c3 or p12; omit for this conversation.")
      .optional(),
    order: z.enum(["newest_first", "oldest_first"]).default("newest_first"),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(40),
    include: z
      .array(z.enum(["thinking", "tool_args", "tool_results", "system_messages", "system_prompt"]))
      .describe("Item kinds hidden by default.")
      .optional(),
    expand: z.string().describe("Item handle such as 12.3, shown in full.").optional(),
  })
  .strict();
export type ThreadHistoryInput = z.input<typeof ThreadHistoryInputSchema>;

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
    o: "newest_first" | "oldest_first";
    a: [number, number];
    k: [number, number];
  };
  const body = `${ref}:${value.o === "newest_first" ? "n" : "o"}${cursorKeyText({ position: value.k[0], sequence: value.k[1] })}@${cursorKeyText({ position: value.a[0], sequence: value.a[1] })}`;
  const threadId = (JSON.parse(Buffer.from(cursor, "base64url").toString()) as { t: string }).t;
  return `${body}~${cursorTag(threadId, body)}`;
}

function renderDatedItems(
  items: readonly HistoryItem[],
  state: { previousDate?: string; previousTime?: string },
): string[] {
  return items.flatMap((item) => {
    const match = /^(.*) {2}(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(\n|$)/u.exec(item.text);
    if (!match) return [item.text];
    const [, prefix, date, time, ending] = match;
    const lines = date === state.previousDate ? [] : [date as string];
    const showTime = date !== state.previousDate || time !== state.previousTime;
    state.previousDate = date;
    state.previousTime = time;
    lines.push(
      `${prefix}${showTime ? `  ${time}` : ""}${ending}${item.text.slice(match[0].length)}`,
    );
    return lines;
  });
}

function cap(text: string, budget: number, tokenizer: TokenizerFamily, suffix: string): string {
  const tokens = (value: string) =>
    estimateModelPartTokens({ type: "text", text: value }, tokenizer);
  if (tokens(text) <= budget) return text;
  const chars = Array.from(text);
  let lo = 0,
    hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tokens(chars.slice(0, mid).join("") + suffix) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("") + suffix;
}
export async function readThreadHistory({
  repos,
  registry,
  caller,
  input,
  tokenizer,
}: {
  repos: ThreadRepositories;
  registry: ToolRegistry;
  caller: Thread;
  input: ThreadHistoryInput;
  tokenizer: TokenizerFamily;
}) {
  return repos.readSnapshot(async () => {
    const resolved = await resolveReadableThread({
      caller,
      ref: input.ref,
      threads: repos.threads,
    });
    if (!resolved.ok) return resolved;
    const target = resolved.target;
    const include = new Set<HistoryInclude>(input.include ?? []);
    const order = input.order ?? "newest_first";
    const tokens = (text: string) => estimateModelPartTokens({ type: "text", text }, tokenizer);
    async function header(segment: TranscriptSegment, opensSegment = true, segmentCount?: number) {
      const bake = segment.bakeId ? await repos.promptBakes.findById(segment.bakeId) : null;
      const owner = bake
        ? await repos.threads.findByIdIncludingDeleted(bake.ownerThreadId)
        : target;
      const opened = segment.openedBy ? await repos.turns.findById(segment.openedBy.turnId) : null;
      const through = segment.compactedThrough
        ? await repos.turns.findById(segment.compactedThrough.turnId)
        : null;
      return `${target.ref} (Agent: ${owner?.agentName ?? "default"})  ${order.replace("_", " ")}\nsegment ${segment.index}${segmentCount ? ` of ${segmentCount}` : ""}: ${segment.openedBy ? `${segment.openedBy.kind} at ${opened?.position}` : "initial prompt"}${through ? ` (summarized through ${through.position})` : ""}${opensSegment && include.has("system_prompt") && bake ? `\nsystem_prompt:\n${cap(bake.composedSystemPrompt, 4000, tokenizer, "\n[prompt truncated]")}` : ""}`;
    }
    if (input.expand) {
      const match = /^([1-9]\d*)(?:\.(\d+))?$/.exec(input.expand);
      if (!match) return threadReadError("item_not_found", "Invalid item handle");
      const item = await readTranscriptItem(repos, target, {
        position: Number(match[1]),
        ...(match[2] !== undefined ? { sequence: Number(match[2]) } : {}),
      });
      if (!item) return threadReadError("item_not_found", "History item not found");
      const rendered = renderHistoryItem({
        ...item.entry,
        registry,
        toolPairs: await loadHistoryToolPairs(repos.blocks, [item.entry]),
        include,
        expand: true,
        ownerRef:
          item.entry.turn.threadId !== target.id
            ? item.owners.find((o) => o.threadId === item.entry.turn.threadId)?.ref
            : undefined,
      });
      const heading = await header(item.segment);
      const text = rendered?.text ?? "";
      return {
        output: `${heading}\n\n${cap(text, 16000 - tokens(heading) - 10, tokenizer, "\n[item truncated at expansion limit]")}`,
        metadata: { documentRevisions: rendered?.documents ?? [] },
      };
    }
    const items: HistoryItem[] = [];
    const live: HistoryItem[] = [];
    let heading = "";
    let used = 0;
    const requestedCursor = input.cursor
      ? internalHistoryCursor(input.cursor, target, order)
      : undefined;
    if (requestedCursor && typeof requestedCursor !== "string") return requestedCursor;
    let next = requestedCursor;
    let stopped = false;
    let scanned = 0;
    try {
      do {
        const page = await readTranscriptPageForProjection(repos, target, {
          order,
          unit: "item",
          limit: 200,
          ...(next ? { cursor: next } : {}),
        });
        if (!heading) {
          heading = await header(page.segment, page.opensSegment, page.segmentCount);
          used = tokens(heading) + 300;
        }
        const rows = page.entries.flatMap<{ turn: Turn; block: Block | null }>((entry) =>
          entry.blocks.length
            ? entry.blocks.map((block) => ({ turn: entry.turn, block }))
            : [{ turn: entry.turn, block: null }],
        );
        scanned += rows.length;
        if (order === "newest_first") rows.reverse();
        const tail = (page.unsettledTail ?? [])
          .flatMap<{ turn: Turn; block: Block | null }>((entry) =>
            entry.blocks.length
              ? entry.blocks.map((block) => ({ turn: entry.turn, block }))
              : [{ turn: entry.turn, block: null }],
          )
          .reverse();
        const toolPairs = await loadHistoryToolPairs(repos.blocks, [...tail, ...rows]);
        for (const [pending, entries] of [
          [true, tail],
          [false, rows],
        ] as const) {
          for (const entry of entries) {
            const item = renderHistoryItem({
              ...entry,
              registry,
              toolPairs,
              include,
              ownerRef:
                entry.turn.threadId !== target.id
                  ? page.owners.find((o) => o.threadId === entry.turn.threadId)?.ref
                  : undefined,
            });
            if (!item) continue;
            const handle = `${item.position}${item.sequence < 0 ? "" : `.${item.sequence}`}`;
            const text = cap(item.text, 2000, tokenizer, `\n…expand: ${handle}`);
            const cost = tokens(text) + 5;
            if (used + cost > 8000 || items.length + live.length >= (input.limit ?? 40)) {
              stopped = true;
              break;
            }
            used += cost;
            (pending ? live : items).push({ ...item, text });
            if (!pending && page.endCursor)
              next = cursorAfter(page.endCursor, {
                position: item.position,
                sequence: item.sequence,
              });
          }
          if (stopped) break;
        }
        if (stopped) {
          // A live preview has no chain key. Its restart cursor begins at the settled prefix.
          if (items.length === 0) next = page.restartCursor;
          break;
        }
        next = page.nextCursor;
        if (page.segmentBoundary || scanned >= 2000) break;
      } while (next);
    } catch (error) {
      if (error instanceof InvalidTranscriptCursorError)
        return threadReadError("invalid_cursor", error.message);
      throw error;
    }
    items.sort((a, b) => a.position - b.position || a.sequence - b.sequence);
    live.sort((a, b) => a.position - b.position || a.sequence - b.sequence);
    const documentRevisions = [
      ...new Map(
        [...items, ...live].flatMap((item) => item.documents).map((ref) => [ref.documentId, ref]),
      ).values(),
    ] as DocumentRevisionEvidence[];
    const key = (item: HistoryItem) =>
      `${item.position}${item.sequence < 0 ? "" : `.${item.sequence}`}`;
    const range = items.length
      ? `  ${key(items[0] as HistoryItem)} to ${key(items.at(-1) as HistoryItem)}`
      : "";
    const dateState: { previousDate?: string; previousTime?: string } = {};
    const output = [
      heading.replace("\n", `${range}\n`),
      ...renderDatedItems(items, dateState),
      ...(live.length
        ? ["in progress (not part of this cursor):", ...renderDatedItems(live, dateState)]
        : []),
      ...(next
        ? [
            `next: thread_history(${JSON.stringify({ ref: target.ref, cursor: modelHistoryCursor(next, target.ref as string) })})`,
          ]
        : []),
    ].join("\n\n");
    return { output, metadata: { documentRevisions } };
  });
}
