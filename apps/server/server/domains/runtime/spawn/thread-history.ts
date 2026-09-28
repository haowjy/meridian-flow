/** Bounded, segmented model history over the shared effective-transcript reader. */
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
import { type HistoryInclude, type HistoryItem, renderHistoryItem } from "./history-item.js";
import { resolveReadableThread, threadReadError } from "./resolve-readable-thread.js";
export const ThreadHistoryInputSchema = z
  .object({
    ref: z.string().optional(),
    order: z.enum(["newest_first", "oldest_first"]).default("newest_first"),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(40),
    include: z
      .array(z.enum(["thinking", "tool_args", "tool_results", "system_messages", "system_prompt"]))
      .optional(),
    expand: z.string().optional(),
  })
  .strict();
export type ThreadHistoryInput = z.input<typeof ThreadHistoryInputSchema>;

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
      return `${target.ref} (Agent: ${owner?.agentName ?? "default"})  ${order.replace("_", " ")}\nsegment ${segment.index}${segmentCount ? ` of ${segmentCount}` : ""}: ${segment.openedBy ? `${segment.openedBy.kind} at ${opened?.position}` : "initial prompt"}${through ? ` (summarized through ${through.position})` : ""}, bake ${bake?.contentHash.slice(0, 8) ?? "none"}${opensSegment && include.has("system_prompt") && bake ? `\nsystem_prompt:\n${cap(bake.composedSystemPrompt, 4000, tokenizer, "\n[prompt truncated]")}` : ""}`;
    }
    if (input.expand) {
      const match = /^([1-9]\d*)(?:\.(\d+))?$/.exec(input.expand);
      if (!match) return threadReadError("item_not_found", "Invalid item handle");
      const item = await readTranscriptItem(repos, target, {
        position: Number(match[1]),
        ...(match[2] !== undefined ? { sequence: Number(match[2]) } : {}),
      });
      if (!item) return threadReadError("item_not_found", "History item not found");
      const rendered = await renderHistoryItem({
        ...item.entry,
        registry,
        blocks: repos.blocks,
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
    let next = input.cursor;
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
        for (const [pending, entries] of [
          [true, tail],
          [false, rows],
        ] as const) {
          for (const entry of entries) {
            const item = await renderHistoryItem({
              ...entry,
              registry,
              blocks: repos.blocks,
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
    const output = [
      heading.replace("\n", `${range}\n`),
      ...items.map((item) => item.text),
      ...(live.length
        ? ["in progress (not part of this cursor):", ...live.map((item) => item.text)]
        : []),
      ...(next ? [`next_cursor: ${next}`] : []),
    ].join("\n\n");
    return { output, metadata: { documentRevisions } };
  });
}
