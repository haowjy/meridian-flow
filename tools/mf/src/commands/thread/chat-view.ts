/**
 * `thread view`: the chat transcript as the app's view model decides it. Hydrate the snapshot,
 * run `viewTranscript` over its facts, and print rows structurally (text) or as the versioned
 * `chatView: 2` envelope (JSON). Nothing here decides a row; it only prints what the view
 * model returned, and states `inputs`: what the view was computed from.
 */
import type { JsonValue, ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import {
  type ProviderErrorResponse,
  readCompactionFacts,
  readHandoffBrief,
  readHandoffSeed,
  replyProviderError,
  type Thread,
  type Turn,
} from "@meridian/contracts/threads";
import {
  type DeliveryEvent,
  type FoldDigest,
  queuedWriterTurnIds,
  type RowIdentity,
  type TranscriptView,
  type TurnStats,
  type ViewItem,
  type ViewRow,
  viewTranscript,
  type WriterReferenceOccurrence,
} from "@meridian/thread-client";
import { oneLine, truncate } from "../../core/output";
import { asRecord, liveStatusLabel } from "./transcript";

export const CHAT_VIEW_VERSION = 2;

const TEXT_LIMIT = 1_500;

export type ChatViewInputs = {
  /** Where the turns came from. */
  turns: "snapshot";
  /** The fork's inherited history is not read here; a fork's own rows start at its fork point. */
  inherited: "omitted";
  localRecords: "none";
  standIns: "none";
  /** No optimistic opening seed: a handoff's seed appears when the server has it. */
  opening: "none";
  /** No live children are known, so a reply is never held open for background subagents. */
  liveActivity: "none";
  queued: "snapshot pending inbox";
};

/** A tool call the writer sees in a fold. `--full` adds what the app's tool row is drawn from. */
export type ChatTool = {
  name: string;
  status: string;
  isError: boolean;
  callId?: string | null;
  input?: JsonValue | null;
  result?: JsonValue | null;
  message?: string | null;
  streamedOutput?: string | null;
};

export type ChatDelivery = {
  turnId: string;
  childThreadId: string | null;
  agentName: string | null;
  title: string | null;
  outcome: string | null;
  /** The notification's text; empty for an attachment-only message. */
  message: string;
};

export type ChatItem =
  | {
      kind: "process";
      visible: boolean;
      digest: FoldDigest;
      runs: Array<{ run: "reasoning"; text: string } | { run: "activity"; tools: ChatTool[] }>;
    }
  | { kind: "text"; text: string }
  | {
      kind: "report";
      summary: string;
      partial: boolean;
      artifacts: number;
      reason: string | null;
      /** `--full`: the report's payload and artifact references. */
      payload?: JsonValue;
      artifactRefs?: unknown[];
    }
  | {
      kind: "artifact";
      blockType: string;
      card: string | null;
      agentName: string | null;
      title: string | null;
      outcome: string | null;
      /** A plain row's body, when the block is neither a card nor an image. */
      body: string | null;
      /** `--full`: the card's content (props and interrupt) and a direct launch's saved result. */
      content?: JsonValue;
      direct?: unknown;
    }
  /** The reply's delivery groups, last as the app draws them. A group of several is one merged row. */
  | { kind: "delivery"; groups: ChatDelivery[][] };

export type ChatRow = {
  identity: RowIdentity;
  renderKey: string;
  kind: ViewRow["kind"];
  role: Turn["role"];
  status: Turn["status"];
  /** The source thread an inherited row came from; null for this chat's own rows. */
  inheritedFrom: string | null;
  queued: boolean;
  continuing: boolean;
  /** A writer message's text. */
  text?: string;
  /** Where the writer's references and skills sit in `text`. */
  occurrences?: { references: WriterReferenceOccurrence[]; skills: unknown[] };
  /** How this reply's edits are worded: drafted or edited. */
  writeMode?: "direct" | "draft";
  error?: string;
  /** Why a failed reply failed, and the provider's own answer when it gave one. */
  failureReason?: string;
  providerError?: ProviderErrorResponse;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: string };
  items?: ChatItem[];
  /** Index in `items` where the writer-facing answer starts. */
  finalFrom?: number;
  /** Tool calls the writer sees elsewhere, so they have no row. */
  hiddenToolCalls?: string[];
  response?: { parts: string[]; stats: TurnStats };
  compaction?: ReturnType<typeof readCompactionFacts>;
  handoff?: ReturnType<typeof readHandoffSeed> & { latest: boolean; brief: string | null };
  references?: Array<{ threadId: string; title: string | null }>;
};

export type ChatViewEnvelope = {
  chatView: typeof CHAT_VIEW_VERSION;
  thread: {
    id: string;
    ref: string | null;
    title: string | null;
    projectId: string;
    workId: string | null;
    agentName: string | null;
    status: Thread["status"];
    turnCount: number;
    totalCostUsd: string;
  };
  live: { status: string; runningTurnId: string | null; pending: number; actionRequired: boolean };
  inputs: ChatViewInputs;
  rows: ChatRow[];
  showing: number;
  total: number;
};

export type RowSelection = { full: boolean; turnId?: string; last?: number };

/** The view model over a snapshot's facts: no local records, stand-ins or live activity. */
export function viewSnapshot(snapshot: Pick<ThreadSnapshotResponse, "liveState">, turns: Turn[]) {
  return viewTranscript({
    turns,
    activity: { awaitingSubagents: false },
    queued: queuedWriterTurnIds(snapshot.liveState.pending),
  });
}

/** `--turn` (id or prefix) or the last N rows (all with --full); `total` counts the matches. */
export function selectRows(
  rows: readonly ViewRow[],
  options: RowSelection,
): { rows: ViewRow[]; total: number } {
  const matched = options.turnId
    ? rows.filter((row) => row.turn.id.startsWith(options.turnId ?? ""))
    : [...rows];
  const last = options.full || options.turnId ? matched.length : (options.last ?? 20);
  return { rows: matched.slice(-last), total: matched.length };
}

export function projectChatView(
  snapshot: ThreadSnapshotResponse,
  view: TranscriptView,
  options: RowSelection,
): ChatViewEnvelope {
  const { rows, total } = selectRows(view.rows, options);
  const { thread } = snapshot;
  return {
    chatView: CHAT_VIEW_VERSION,
    thread: {
      id: thread.id,
      ref: thread.ref,
      title: thread.title,
      projectId: thread.projectId,
      workId: thread.workId,
      agentName: thread.agentName,
      status: thread.status,
      turnCount: thread.turnCount,
      totalCostUsd: thread.totalCostUsd,
    },
    live: {
      status: liveStatusLabel(snapshot),
      runningTurnId: snapshot.liveState.runningTurnId,
      pending: snapshot.liveState.pending.items.length,
      actionRequired: snapshot.actionRequired,
    },
    inputs: {
      turns: "snapshot",
      inherited: "omitted",
      localRecords: "none",
      standIns: "none",
      opening: "none",
      liveActivity: "none",
      queued: "snapshot pending inbox",
    },
    rows: rows.map((row) => chatRow(row, view, options)),
    showing: rows.length,
    total,
  };
}

function chatRow(row: ViewRow, view: TranscriptView, limits: { full: boolean }): ChatRow {
  const { turn } = row;
  const out: ChatRow = {
    identity: row.identity,
    renderKey: row.renderKey,
    kind: row.kind,
    role: turn.role,
    status: turn.status,
    inheritedFrom: row.inherited?.ownerThreadId ?? null,
    queued: row.queued,
    continuing: row.continuing,
  };
  if (turn.error) out.error = turn.error;
  if (turn.role === "assistant" && turn.status === "error") {
    const reason = asRecord(turn.metadata).reason;
    if (typeof reason === "string") out.failureReason = reason;
    const provider = replyProviderError(turn.metadata);
    if (provider)
      out.providerError = limits.full
        ? provider
        : { ...provider, message: truncate(oneLine(provider.message), 300) };
  }
  if (turn.model) out.model = turn.model;
  if (turn.role === "assistant")
    out.usage = {
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      costUsd: turn.totalCostUsd,
    };
  const writer = view.writer.get(turn.id);
  if (writer) {
    out.text = limits.full ? writer.text : truncate(writer.text, TEXT_LIMIT);
    out.occurrences = { references: writer.references, skills: writer.skills };
  }
  if (turn.role === "assistant") out.writeMode = turn.writeMode ?? "direct";
  const assistant = view.items.get(turn.id);
  if (assistant) {
    out.items = assistant.items.map((item) => chatItem(item, limits));
    if (row.deliveries.length)
      out.items.push({ kind: "delivery", groups: row.deliveries.map((g) => g.map(chatDelivery)) });
    out.finalFrom = assistant.finalFrom;
    if (assistant.hiddenToolCallIds.length) out.hiddenToolCalls = assistant.hiddenToolCallIds;
  }
  if (row.response)
    out.response = { parts: row.response.parts.map((part) => part.id), stats: row.response.stats };
  if (row.kind === "compaction") out.compaction = readCompactionFacts(turn);
  if (row.kind === "handoff-seed") {
    const seed = readHandoffSeed(turn);
    if (seed) out.handoff = { ...seed, latest: row.latest, brief: readHandoffBrief(turn) };
  }
  if (row.kind === "thread-reference") out.references = [...row.references];
  return out;
}

function chatDelivery(event: DeliveryEvent): ChatDelivery {
  return {
    turnId: event.turn.id,
    childThreadId: event.childThreadId ?? null,
    agentName: event.agentName ?? null,
    title: event.title ?? null,
    outcome: event.subagentUpdate?.outcome ?? null,
    message: event.message,
  };
}

function chatItem(item: ViewItem, limits: { full: boolean }): ChatItem {
  const clip = (text: string) => (limits.full ? text : truncate(text, TEXT_LIMIT));
  switch (item.kind) {
    case "process":
      return {
        kind: "process",
        visible: item.visible,
        digest: item.digest,
        runs: item.runs.map((run) =>
          run.kind === "reasoning"
            ? {
                run: "reasoning",
                text: clip(run.texts.join("\n")),
              }
            : {
                run: "activity",
                tools: run.tools.map((tool) => ({
                  name: tool.toolName,
                  status: tool.status,
                  isError: tool.isError,
                  ...(limits.full
                    ? {
                        callId: tool.toolCallId,
                        input: tool.input,
                        result: tool.result,
                        message: tool.message,
                        streamedOutput: tool.streamedOutput,
                      }
                    : {}),
                })),
              },
        ),
      };
    case "text":
      return { kind: "text", text: clip(item.text) };
    case "report":
      return {
        kind: "report",
        summary: clip(item.report.summary),
        partial: item.report.partial === true,
        artifacts: item.report.artifacts.length,
        reason: item.report.reason ?? null,
        ...(limits.full
          ? { payload: item.report.payload, artifactRefs: item.report.artifacts }
          : {}),
      };
    case "artifact":
      return {
        kind: "artifact",
        blockType: item.block.blockType,
        card: item.card?.kind ?? null,
        agentName: item.card?.agentName ?? null,
        title: item.card?.title ?? null,
        outcome: item.card?.outcome ?? null,
        body: item.text === null ? null : clip(item.text),
        ...(limits.full ? { content: item.block.content, direct: item.direct } : {}),
      };
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The fold counts in plain words: `read 2 docs, 3 steps`. */
export function plainDigest(digest: FoldDigest, drafted = false): string {
  const parts: string[] = [];
  if (digest.invokedSkills.length) parts.push(`invoked ${digest.invokedSkills.join(", ")}`);
  if (digest.readDocuments) parts.push(`read ${plural(digest.readDocuments, "doc")}`);
  if (digest.editedDocuments)
    parts.push(`${drafted ? "drafted" : "edited"} ${plural(digest.editedDocuments, "doc")}`);
  if (digest.steps) parts.push(plural(digest.steps, "step"));
  return parts.join(", ");
}

function sumDigests(items: readonly ChatItem[]): FoldDigest {
  const total: FoldDigest = { invokedSkills: [], readDocuments: 0, editedDocuments: 0, steps: 0 };
  for (const item of items) {
    if (item.kind !== "process" || !item.visible) continue;
    for (const slug of item.digest.invokedSkills)
      if (!total.invokedSkills.includes(slug)) total.invokedSkills.push(slug);
    total.readDocuments += item.digest.readDocuments;
    total.editedDocuments += item.digest.editedDocuments;
    total.steps += item.digest.steps;
  }
  return total;
}

/** Text mode only: a space before a reference that touches the word before it (the app draws a chip there). */
function setApartReferences(
  text: string,
  references: readonly WriterReferenceOccurrence[],
): string {
  let out = text;
  for (const { from } of [...references].sort((a, b) => b.from - a.from))
    if (from > 0 && !/\s/.test(text[from - 1] ?? " "))
      out = `${out.slice(0, from)} ${out.slice(from)}`;
  return out;
}

function indent(text: string, by = "  "): string[] {
  return text.split("\n").map((line) => `${by}${line}`);
}

function rowLines(row: ChatRow): string[] {
  const drafted = row.writeMode === "draft";
  const flags = [
    row.inheritedFrom ? `inherited from ${row.inheritedFrom}` : "",
    row.queued ? "queued" : "",
    row.continuing ? "reply continues" : "",
    row.status === "complete" ? "" : row.status,
  ].filter(Boolean);
  const tag = flags.length ? ` (${flags.join(", ")})` : "";
  const id = `[${row.identity.turnId ?? "local"} ${row.identity.kind}#${row.identity.occurrence}]`;
  const lines: string[] = [];
  switch (row.kind) {
    case "compaction": {
      const facts = row.compaction;
      const tokens =
        facts?.tokensBefore != null && facts.tokensAfter != null
          ? `, ${facts.tokensBefore} to ${facts.tokensAfter} tokens`
          : "";
      lines.push(`compaction: ${facts?.trigger ?? "auto"}${tokens}${tag} ${id}`);
      if (facts?.instructions) lines.push(...indent(`instructions: ${facts.instructions}`));
      break;
    }
    case "handoff-seed":
      lines.push(
        `handoff brief: from ${row.handoff?.sourceThreadId ?? "?"}${row.handoff?.latest ? " (latest)" : ""}${tag} ${id}`,
      );
      if (row.handoff?.brief) lines.push(...indent(`brief: ${oneLine(row.handoff.brief)}`));
      break;
    case "thread-reference":
      lines.push(
        `references: ${(row.references ?? []).map((ref) => ref.title ?? ref.threadId).join(", ")}${tag} ${id}`,
      );
      break;
    case "turn":
      if (row.items) {
        const summary = plainDigest(sumDigests(row.items), drafted);
        lines.push(
          `${row.role === "assistant" ? "reply" : row.role}: ${summary || "no steps folded"}${tag} ${id}`,
        );
      } else {
        const text = oneLine(setApartReferences(row.text ?? "", row.occurrences?.references ?? []));
        lines.push(`you: ${text}${tag} ${id}`);
      }
      break;
  }
  if (row.error) lines.push(...indent(`error: ${row.error}`));
  if (row.failureReason) lines.push(...indent(`failure reason: ${row.failureReason}`));
  if (row.providerError)
    lines.push(
      ...indent(
        `provider error (${row.providerError.status ?? "in-stream"}): ${row.providerError.message}`,
      ),
    );
  row.items?.forEach((item, index) => {
    const marker = index === row.finalFrom ? "answer: " : "";
    switch (item.kind) {
      case "process": {
        if (!item.visible) break;
        const tools = item.runs.flatMap((run) =>
          run.run === "activity" ? run.tools.map((t) => t.name) : [],
        );
        const reasoning = item.runs.filter((run) => run.run === "reasoning").length;
        lines.push(
          ...indent(
            `fold: ${plainDigest(item.digest, drafted) || "reasoning"}${tools.length ? ` (${tools.join(", ")})` : ""}${reasoning ? `${tools.length ? "; " : " ("}${plural(reasoning, "thinking run")}${tools.length ? "" : ")"}` : ""}`,
          ),
        );
        break;
      }
      case "text":
        lines.push(...indent(`${marker}text: ${item.text.trim()}`));
        break;
      case "report":
        lines.push(
          ...indent(
            `${marker}report${item.partial ? " (partial)" : ""}: ${oneLine(item.summary)}${item.artifacts ? ` [${plural(item.artifacts, "artifact")}]` : ""}`,
          ),
        );
        break;
      case "artifact":
        lines.push(
          ...indent(
            `${marker}card: ${item.card ?? item.blockType}${item.title ? `: ${oneLine(item.title)}` : item.body ? `: ${oneLine(item.body)}` : ""}${item.outcome ? ` (${item.outcome})` : ""}`,
          ),
        );
        break;
      case "delivery":
        for (const group of item.groups)
          lines.push(
            ...indent(
              `delivery: ${group.map((event) => `${event.agentName ?? "message"}${event.outcome ? ` ${event.outcome}` : ""}${event.childThreadId ? ` [${event.childThreadId}]` : ""}${event.message && !event.outcome ? ` ${oneLine(event.message)}` : ""}`).join("; ")}`,
            ),
          );
        break;
    }
  });
  return lines;
}

export function renderChatView(view: ChatViewEnvelope): string {
  const { thread, live, inputs } = view;
  const lines = [
    `thread ${thread.id}${thread.ref ? ` (${thread.ref})` : ""}: ${thread.title ?? "(untitled)"}`,
    `  project ${thread.projectId}  work ${thread.workId ?? "(none)"}  agent ${thread.agentName ?? "?"}`,
    `  live ${live.status}${live.runningTurnId ? ` running ${live.runningTurnId}` : ""}  pending ${live.pending}${live.actionRequired ? "  ACTION REQUIRED" : ""}  cost $${thread.totalCostUsd}`,
    `  chatView ${view.chatView}  rows: showing ${view.showing} of ${view.total}${view.showing < view.total ? " (--full or --turn for more)" : ""}`,
    `  inputs: turns from ${inputs.turns}; inherited history ${inputs.inherited}; local records ${inputs.localRecords}, stand-ins ${inputs.standIns}, live activity ${inputs.liveActivity}; queued from ${inputs.queued}`,
  ];
  const queued = view.rows.filter((row) => row.queued).length;
  for (const row of view.rows) {
    lines.push("");
    lines.push(...rowLines(row));
  }
  if (queued) lines.push("", `queued: ${queued}`);
  return lines.join("\n");
}
