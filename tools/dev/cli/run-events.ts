/**
 * Folds the thread socket's AG-UI stream into compact, dotted CLI events
 * (codex-exec style) and renders each as one text line.
 */
import type { SequencedEvent } from "@meridian/contracts/protocol";
import { oneLine, truncate } from "./output";

export type CliEvent =
  | { type: "turn.started"; seq: string; turnId: string }
  | { type: "message.delta"; seq: string; messageId: string; text: string }
  | { type: "message.completed"; seq: string; messageId: string; text: string }
  | { type: "reasoning.completed"; seq: string; messageId: string; text: string }
  | { type: "tool.started"; seq: string; toolCallId: string; name: string }
  | {
      type: "tool.completed";
      seq: string;
      toolCallId: string;
      name: string;
      args: string;
      result: string;
    }
  | { type: "tool.errored"; seq: string; toolCallId: string }
  | {
      type: "interrupt.requested" | "interrupt.resolved" | "interrupt.expired";
      seq: string;
      turnId: string;
      interruptId: string;
    }
  | { type: "turn.finished"; seq: string; turnId: string }
  | { type: "turn.failed"; seq: string; message: string; error?: unknown }
  | { type: "event"; seq: string; name: string; value?: unknown };

type ToolCallState = { name: string; args: string };

/** Stateful mapper: one instance per followed stream. */
export class RunEventMapper {
  private readonly messages = new Map<string, { kind: "text" | "reasoning"; text: string }>();
  private readonly tools = new Map<string, ToolCallState>();

  map(sequenced: SequencedEvent): CliEvent[] {
    const { seq, event } = sequenced;
    const e = event as unknown as Record<string, unknown> & { type: string };
    switch (e.type) {
      case "RUN_STARTED":
        return [{ type: "turn.started", seq, turnId: String(e.runId) }];
      case "RUN_FINISHED":
        return [{ type: "turn.finished", seq, turnId: String(e.runId) }];
      case "RUN_ERROR":
        return [
          {
            type: "turn.failed",
            seq,
            message: String(e.message ?? "run failed"),
            ...(sequenced.error ? { error: sequenced.error } : {}),
          },
        ];
      case "TEXT_MESSAGE_START":
      case "REASONING_MESSAGE_START":
        this.messages.set(String(e.messageId), {
          kind: e.type === "TEXT_MESSAGE_START" ? "text" : "reasoning",
          text: "",
        });
        return [];
      case "TEXT_MESSAGE_CONTENT":
      case "REASONING_MESSAGE_CONTENT": {
        const messageId = String(e.messageId);
        const delta = String(e.delta ?? "");
        const message = this.messages.get(messageId) ?? {
          kind: e.type === "TEXT_MESSAGE_CONTENT" ? "text" : "reasoning",
          text: "",
        };
        message.text += delta;
        this.messages.set(messageId, message);
        return message.kind === "text"
          ? [{ type: "message.delta", seq, messageId, text: delta }]
          : [];
      }
      case "TEXT_MESSAGE_END":
      case "REASONING_MESSAGE_END": {
        const messageId = String(e.messageId);
        const message = this.messages.get(messageId);
        this.messages.delete(messageId);
        if (!message) return [];
        return [
          {
            type: message.kind === "text" ? "message.completed" : "reasoning.completed",
            seq,
            messageId,
            text: message.text,
          },
        ];
      }
      case "TOOL_CALL_START": {
        const toolCallId = String(e.toolCallId);
        const name = String(e.toolCallName ?? "tool");
        this.tools.set(toolCallId, { name, args: "" });
        return [{ type: "tool.started", seq, toolCallId, name }];
      }
      case "TOOL_CALL_ARGS": {
        const tool = this.tools.get(String(e.toolCallId));
        if (tool) tool.args += String(e.delta ?? "");
        return [];
      }
      case "TOOL_CALL_END":
        return [];
      case "TOOL_CALL_RESULT": {
        const toolCallId = String(e.toolCallId);
        const tool = this.tools.get(toolCallId) ?? { name: "tool", args: "" };
        this.tools.delete(toolCallId);
        return [
          {
            type: "tool.completed",
            seq,
            toolCallId,
            name: tool.name,
            args: tool.args,
            result: String(e.content ?? ""),
          },
        ];
      }
      case "CUSTOM":
        return this.mapCustom(seq, String(e.name), e.value);
      default:
        return [];
    }
  }

  private mapCustom(seq: string, name: string, value: unknown): CliEvent[] {
    const record = (value ?? {}) as Record<string, unknown>;
    if (name === "meridian.interrupt") {
      const state = String(record.state);
      const type =
        state === "created"
          ? "interrupt.requested"
          : state === "resolved"
            ? "interrupt.resolved"
            : "interrupt.expired";
      return [
        {
          type,
          seq,
          turnId: String(record.turnId),
          interruptId: String(record.interruptId),
        },
      ];
    }
    if (name === "meridian.tool.result_error") {
      // Follows its TOOL_CALL_RESULT, so it marks the already-emitted completion.
      return [{ type: "tool.errored", seq, toolCallId: String(record.toolCallId) }];
    }
    return [{ type: "event", seq, name, value }];
  }
}

/** One compact line per event; null means "not shown in text mode". */
export function renderEventLine(event: CliEvent, full: boolean): string | null {
  const limit = full ? Number.POSITIVE_INFINITY : 240;
  switch (event.type) {
    case "turn.started":
      return `turn.started ${event.turnId}`;
    case "message.delta":
    case "reasoning.completed":
    case "event":
      return null;
    case "message.completed":
      return `assistant: ${truncate(event.text.trim(), full ? Number.POSITIVE_INFINITY : 2_000)}`;
    case "tool.started":
      return `tool.started ${event.name} (${event.toolCallId})`;
    case "tool.completed":
      return `tool.completed ${event.name}(${truncate(oneLine(event.args), limit)}) -> ${truncate(oneLine(event.result), limit)}`;
    case "tool.errored":
      return `tool.errored ${event.toolCallId}`;
    case "interrupt.requested":
      return `interrupt.requested ${event.interruptId} on turn ${event.turnId}`;
    case "interrupt.resolved":
    case "interrupt.expired":
      return `${event.type} ${event.interruptId}`;
    case "turn.finished":
      return `turn.finished ${event.turnId}`;
    case "turn.failed":
      return `turn.failed ${event.message}`;
  }
}
