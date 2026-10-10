/** Durable notices injected into model context before the next request. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";

export type NoticeScope = { kind: "thread"; threadId: string };

type NoticeFields = {
  scope: NoticeScope;
  message: string;
  data: Record<string, unknown>;
};

export type NoticeInput =
  | ({ kind: "undo" } & NoticeFields)
  | ({ kind: "awareness_degraded" } & NoticeFields)
  | {
      kind: "work_switched";
      scope: { kind: "thread"; threadId: ThreadId };
      data: Record<string, unknown>;
      message: string;
    };

export type Notice = NoticeFields & {
  kind: string;
  id: number;
  createdAt: Date;
};

export interface NoticePort {
  record(input: NoticeInput): Promise<void>;
  peek(threadId: string): Promise<Notice[]>;
  consume(ids: readonly number[]): Promise<void>;
}

export type WriterWorkSwitchedNoticeData = {
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
  actor: "writer";
  previousScratchUri?: string;
};

export type WriterWorkSwitchedNotice = Extract<NoticeInput, { kind: "work_switched" }>;

export function parseNoticeInput(value: unknown): NoticeInput {
  if (!isRecord(value) || !isRecord(value.scope) || value.scope.kind !== "thread") {
    throw new Error("Invalid model notice");
  }
  const { kind, scope, message, data } = value;
  if (typeof scope.threadId !== "string" || typeof message !== "string" || !isRecord(data)) {
    throw new Error("Invalid model notice");
  }
  if (kind === "undo") {
    return { kind, scope: { kind: "thread", threadId: scope.threadId }, message, data };
  }
  if (
    kind === "awareness_degraded" &&
    Array.isArray(data.documentIds) &&
    data.documentIds.every((id) => typeof id === "string") &&
    Array.isArray(data.documentNames) &&
    data.documentNames.every((name) => typeof name === "string")
  ) {
    return {
      kind,
      scope: { kind: "thread", threadId: scope.threadId },
      message,
      data,
    };
  }
  if (
    kind === "work_switched" &&
    typeof data.previousWorkId === "string" &&
    typeof data.previousWorkName === "string" &&
    typeof data.workId === "string" &&
    typeof data.workName === "string" &&
    data.actor === "writer"
  ) {
    return {
      kind,
      scope: { kind: "thread", threadId: scope.threadId as ThreadId },
      message,
      data: {
        previousWorkId: data.previousWorkId as WorkId,
        previousWorkName: data.previousWorkName,
        workId: data.workId as WorkId,
        workName: data.workName,
        actor: "writer",
        ...(typeof data.previousScratchUri === "string"
          ? { previousScratchUri: data.previousScratchUri }
          : {}),
      },
    };
  }
  throw new Error("Invalid model notice");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createWriterWorkSwitchedNotice(input: {
  threadId: ThreadId;
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
  previousScratchUri?: string;
}): WriterWorkSwitchedNotice {
  const data: WriterWorkSwitchedNoticeData = {
    previousWorkId: input.previousWorkId,
    previousWorkName: input.previousWorkName,
    workId: input.workId,
    workName: input.workName,
    ...(input.previousScratchUri ? { previousScratchUri: input.previousScratchUri } : {}),
    actor: "writer",
  };
  return {
    kind: "work_switched",
    scope: { kind: "thread", threadId: input.threadId },
    message: workSwitchedNoticeMessage(data),
    data,
  };
}

export function formatWorkSwitchedNotice(data: Record<string, unknown>): string | null {
  if (data.actor !== "writer") return null;
  const previousWorkName = nonEmptyString(data.previousWorkName);
  const workName = nonEmptyString(data.workName);
  return previousWorkName && workName
    ? workSwitchedNoticeMessage({
        previousWorkName,
        workName,
        previousScratchUri: nonEmptyString(data.previousScratchUri) ?? undefined,
      })
    : null;
}

function workSwitchedNoticeMessage(data: {
  previousWorkName: string;
  workName: string;
  previousScratchUri?: string;
}): string {
  return `This conversation's Work switched from ${JSON.stringify(data.previousWorkName)} to ${JSON.stringify(data.workName)}.${data.previousScratchUri ? ` Your earlier notes are at ${data.previousScratchUri} Rebinding did not move them.` : ""}`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
