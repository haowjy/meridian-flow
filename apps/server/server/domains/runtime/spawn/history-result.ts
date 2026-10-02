/**
 * `thread_history`'s structured result (D8) and the pure text rendering the
 * model reads (D10). Code mode would return `HistoryResult` itself.
 */
import type { ExecutionReportSource, SavedOutcome } from "@meridian/contracts/spawn";
import type { JsonValue } from "@meridian/contracts/threads";
import type { ThreadHistoryInput } from "./thread-history.js";

export interface SavedReportView {
  outcome: SavedOutcome;
  source: ExecutionReportSource;
  reason: string | null;
  partial: boolean;
  /** The saved summary, then any payload; never the `return_result` arguments. */
  content: string;
  /** Lines were cut from `content` in this view; expanding the turn shows them. */
  truncated?: true;
}

/**
 * One display item. `index` is the item's number inside its turn, from 1 in
 * display order; it's present wherever the item has a handle in this view.
 * `text` absent means the item is listed on one line with its size only.
 */
export type HistoryItem =
  | { kind: "message"; index?: number; text?: string; tokens: number; truncated?: true }
  | { kind: "thinking"; index?: number; text?: string; tokens: number; truncated?: true }
  | {
      kind: "system";
      index?: number;
      label: string;
      text?: string;
      tokens: number;
      truncated?: true;
    }
  | {
      kind: "tool";
      index?: number;
      tool: string;
      brief: string;
      /** `running` only in the live tail; a settled call with no result was cancelled. */
      state: "done" | "error" | "cancelled" | "running";
      resultTokens?: number;
      args?: string;
      result?: string;
      truncated?: true;
    };

export interface HistoryTurn {
  /**
   * The turn's ordinal among the thread's conversation turns (requests and
   * replies), with no gaps; stable across pages, order and compaction. System
   * turns, shown only with `system_messages`, have none and can't be expanded.
   */
  number?: number;
  role: "user" | "assistant" | "system";
  /** Heading word: user, "user, steer", agent, assistant, "system: Work update" and the like. */
  label: string;
  /** Owning conversation of an inherited (forked) turn. */
  from?: string;
  /** "YYYY-MM-DD HH:MM", with the `timestamps` include. */
  at?: string;
  items: HistoryItem[];
  /** Routine calls left out of this view. */
  hiddenCount: number;
  report?: SavedReportView;
  /** Earlier turns were compacted; the marker renders above this turn. */
  summarizedBefore?: boolean;
  failure?: { status: string; error?: string; reason?: string };
}

export interface HistoryResult {
  ref: string;
  /** `page`: the default walk. `turn`: one expanded turn. `item`: one item in full. */
  view: "page" | "turn" | "item";
  systemPrompt?: string;
  /** Finished turns, chronological. */
  turns: HistoryTurn[];
  /** The live tail, never part of the cursor. */
  inProgress: HistoryTurn[];
  /** Present only when more pages exist. */
  next?: { call: ThreadHistoryInput };
}

const call = (input: ThreadHistoryInput) => `thread_history(${JSON.stringify(input)})`;
const formatTokens = (tokens: number) => `${tokens.toLocaleString("en-US")} tokens`;

function truncation(result: HistoryResult, turn: HistoryTurn, item: HistoryItem) {
  if (!item.truncated) return "";
  return turn.number === undefined || item.index === undefined
    ? "\n(truncated)"
    : `\n(truncated: ${call({ ref: result.ref, expand: `${turn.number}.${item.index}` })})`;
}

function toolLine(item: Extract<HistoryItem, { kind: "tool" }>, inProgress: boolean) {
  const state =
    item.state === "error"
      ? " (failed)"
      : item.state === "cancelled"
        ? " (cancelled)"
        : item.state === "running" && !inProgress
          ? " (running)"
          : "";
  return `${item.tool} ${item.brief}`.trimEnd() + state;
}

function sized(line: string, tokens: number | undefined) {
  return tokens === undefined ? line : `${line} (${formatTokens(tokens)})`;
}

function itemLabel(item: HistoryItem) {
  return item.kind === "system" ? item.label : item.kind === "thinking" ? "thinking" : "message";
}

function pageItem(result: HistoryResult, turn: HistoryTurn, item: HistoryItem, live: boolean) {
  const truncated = truncation(result, turn, item);
  switch (item.kind) {
    case "message":
      return `${item.text ?? ""}${truncated}`;
    case "thinking":
      return `Thinking:\n${item.text ?? ""}${truncated}`;
    case "system":
      return `${item.label}${item.text ? `\n${item.text}` : ""}${truncated}`;
    case "tool":
      return (
        [
          toolLine(item, live),
          ...(item.args !== undefined ? [item.args] : []),
          ...(item.result !== undefined ? [item.result] : []),
        ].join("\n") + truncated
      );
  }
}

function turnItem(result: HistoryResult, turn: HistoryTurn, item: HistoryItem) {
  const key = `${turn.number}.${item.index}`;
  if (item.kind === "tool") return `${key} ${sized(toolLine(item, false), item.resultTokens)}`;
  if (item.text === undefined) return `${key} ${sized(itemLabel(item), item.tokens)}`;
  const truncated = truncation(result, turn, item);
  const head = item.kind === "message" ? `${key} ` : `${key} ${itemLabel(item)}\n`;
  return `${head}${item.text}${truncated}`;
}

function singleItem(turn: HistoryTurn, item: HistoryItem) {
  const key = `${turn.number}.${item.index}`;
  const truncated = item.truncated ? "\n[item truncated at expansion limit]" : "";
  if (item.kind === "tool")
    return (
      [
        `${key} ${toolLine(item, false)}`,
        ...(item.args !== undefined ? [item.args] : []),
        ...(item.result !== undefined ? [item.result] : []),
      ].join("\n") + truncated
    );
  return `${key} ${itemLabel(item)}\n${item.text ?? ""}${truncated}`;
}

function reportBlock(result: HistoryResult, turn: HistoryTurn, report: SavedReportView) {
  const outcome = report.outcome === "succeeded" ? "completed" : report.outcome;
  const source = report.source === "return_result" ? "" : `, ${report.source}`;
  const notes = [
    ...(report.partial && report.outcome === "succeeded" ? ["partial"] : []),
    ...(report.reason ? [`reason: ${report.reason}`] : []),
  ];
  return [
    `Report (${outcome}${source})`,
    ...(notes.length ? [notes.join("; ")] : []),
    ...(report.content ? [report.content] : []),
    ...(report.truncated && turn.number !== undefined
      ? [`(report truncated: ${call({ ref: result.ref, expand: turn.number })})`]
      : []),
  ].join("\n");
}

function renderTurn(result: HistoryResult, turn: HistoryTurn, live: boolean): string {
  // A live turn that so far only calls tools reads as its running calls.
  if (
    live &&
    turn.number !== undefined &&
    turn.items.length > 0 &&
    turn.items.every((item) => item.kind === "tool")
  )
    return turn.items
      .map((item) => `[${turn.number}] ${pageItem(result, turn, item, true)}`)
      .join("\n");
  const heading = `${turn.number === undefined ? "" : `[${turn.number}] `}${turn.label}${turn.from ? ` (from ${turn.from})` : ""}${turn.at ? `  ${turn.at}` : ""}`;
  const items = turn.items.map((item) =>
    result.view === "page"
      ? pageItem(result, turn, item, live)
      : result.view === "turn"
        ? turnItem(result, turn, item)
        : singleItem(turn, item),
  );
  const failure = turn.failure
    ? [
        `${turn.failure.status}${turn.failure.error ? `: ${turn.failure.error}` : ""}`,
        ...(turn.failure.reason ? [`failure reason: ${turn.failure.reason}`] : []),
      ]
    : [];
  const hidden =
    turn.hiddenCount > 0 && turn.number !== undefined
      ? [
          `(${turn.hiddenCount} routine tool call${turn.hiddenCount === 1 ? "" : "s"} hidden: ${call({ ref: result.ref, expand: turn.number })})`,
        ]
      : [];
  return [
    heading,
    ...items,
    ...failure,
    ...(turn.report ? [reportBlock(result, turn, turn.report)] : []),
    ...hidden,
  ].join("\n");
}

export function renderHistoryResult(result: HistoryResult): string {
  const blocks = [`Conversation ${result.ref}`];
  if (result.systemPrompt !== undefined) blocks.push(`System prompt:\n${result.systemPrompt}`);
  for (const turn of result.turns) {
    if (turn.summarizedBefore) blocks.push("[earlier turns summarized]");
    blocks.push(renderTurn(result, turn, false));
  }
  if (result.inProgress.length)
    blocks.push(
      `In progress\n${result.inProgress.map((turn) => renderTurn(result, turn, true)).join("\n\n")}`,
    );
  if (result.turns.length === 0 && result.inProgress.length === 0)
    blocks.push(result.next ? "Nothing to show on this page." : "No messages yet.");
  if (result.next) blocks.push(`More: ${call(result.next.call)}`);
  return blocks.join("\n\n");
}

/** The tool-result boundary: a history result renders as text; a refusal stays its JSON. */
export function renderThreadHistoryOutput(value: JsonValue): string {
  const isResult =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.view === "string" &&
    Array.isArray(value.turns);
  return isResult ? renderHistoryResult(value as unknown as HistoryResult) : JSON.stringify(value);
}
