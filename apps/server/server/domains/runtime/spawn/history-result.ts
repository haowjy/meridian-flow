import type { ArtifactRef } from "@meridian/contracts/artifacts";
import type { ExecutionReportSource, SavedOutcome } from "@meridian/contracts/spawn";
import type { JsonObject, JsonValue } from "@meridian/contracts/threads";
import { renderRefusal } from "../tools/refusal.js";
import { callLine } from "./history-call-line.js";
import type { ThreadHistoryInput } from "./thread-history.js";

export interface SavedReportView {
  outcome: SavedOutcome;
  source: ExecutionReportSource;
  reason: string | null;
  partial: boolean;
  content: string;
  truncated?: true;
}

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
      args: JsonObject | null;
      state: "done" | "error" | "cancelled" | "running";
      summary?: string;
      resultTokens?: number;
      fullArgs?: string;
      result?: string;
      truncated?: true;
    };

export interface HistoryTurn {
  number?: number;
  role: "user" | "assistant" | "system";
  label: string;
  from?: string;
  at?: string;
  items: HistoryItem[];
  hiddenCount: number;
  report?: SavedReportView;
  summarizedBefore?: boolean;
  cancelled?: true;
}

export interface HistoryResult {
  ref: string;
  view: "page" | "turn" | "item";
  systemPrompt?: string;
  turns: HistoryTurn[];
  inProgress: HistoryTurn[];
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

function sized(line: string, tokens: number | undefined) {
  return tokens === undefined ? line : `${line} (${formatTokens(tokens)})`;
}

function itemLabel(item: HistoryItem) {
  return item.kind === "system" ? item.label : item.kind === "thinking" ? "thinking" : "message";
}

function pageItem(result: HistoryResult, turn: HistoryTurn, item: HistoryItem) {
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
        [callLine(item), ...(item.result !== undefined ? [item.result] : [])].join("\n") + truncated
      );
  }
}

function turnItem(result: HistoryResult, turn: HistoryTurn, item: HistoryItem) {
  const key = `${turn.number}.${item.index}`;
  if (item.kind === "tool") return `${key} ${sized(callLine(item), item.resultTokens)}`;
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
        `${key} ${callLine(item)}`,
        ...(item.fullArgs !== undefined ? [item.fullArgs] : []),
        ...(item.result !== undefined ? [item.result] : []),
      ].join("\n") + truncated
    );
  return `${key} ${itemLabel(item)}\n${item.text ?? ""}${truncated}`;
}

export function reportContent(
  summary: string,
  payload?: JsonValue | null,
  artifacts?: readonly ArtifactRef[] | null,
): string {
  return [
    summary,
    ...(payload !== undefined && payload !== null ? [`payload: ${JSON.stringify(payload)}`] : []),
    ...(artifacts ?? []).map(
      (artifact) =>
        `artifact: ${"uri" in artifact ? artifact.uri : artifact.url}${"label" in artifact && artifact.label ? ` (${artifact.label})` : ""}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderReportBlock(report: SavedReportView, truncated?: string): string {
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
    ...(truncated ? [truncated] : []),
  ].join("\n");
}

function reportBlock(result: HistoryResult, turn: HistoryTurn, report: SavedReportView) {
  return renderReportBlock(
    report,
    report.truncated && turn.number !== undefined
      ? `(report truncated: ${call({ ref: result.ref, expand: turn.number })})`
      : undefined,
  );
}

function renderTurn(result: HistoryResult, turn: HistoryTurn, live: boolean): string {
  if (
    live &&
    turn.number !== undefined &&
    turn.items.length > 0 &&
    turn.items.every((item) => item.kind === "tool")
  )
    return turn.items.map((item) => `[${turn.number}] ${pageItem(result, turn, item)}`).join("\n");
  const heading = `${turn.number === undefined ? "" : `[${turn.number}] `}${turn.label}${turn.from ? ` (from ${turn.from})` : ""}${turn.at ? `  ${turn.at}` : ""}`;
  const items = turn.items.map((item) =>
    result.view === "page"
      ? pageItem(result, turn, item)
      : result.view === "turn"
        ? turnItem(result, turn, item)
        : singleItem(turn, item),
  );
  const cancelled = turn.cancelled ? ["cancelled"] : [];
  const hidden =
    turn.hiddenCount > 0 && turn.number !== undefined
      ? [
          turn.hiddenCount === 1
            ? `(1 routine tool call hidden; list it with ${call({ ref: result.ref, expand: turn.number })})`
            : `(${turn.hiddenCount} routine tool calls hidden; list them with ${call({ ref: result.ref, expand: turn.number })})`,
        ]
      : [];
  return [
    heading,
    ...items,
    ...cancelled,
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

export function renderThreadHistoryOutput(value: JsonValue): string {
  const isResult =
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.view === "string" &&
    Array.isArray(value.turns);
  return isResult ? renderHistoryResult(value as unknown as HistoryResult) : renderRefusal(value);
}
