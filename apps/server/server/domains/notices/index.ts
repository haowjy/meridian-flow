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

export type WorkSwitchedNoticeData = {
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
  actor: "writer" | "model";
  previousScratchUri?: string;
};

export type WorkSwitchedNotice = Extract<NoticeInput, { kind: "work_switched" }>;

export function createWorkSwitchedNotice(input: {
  threadId: ThreadId;
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
  previousScratchUri?: string;
  actor: "writer" | "model";
}): WorkSwitchedNotice {
  const data: WorkSwitchedNoticeData = {
    previousWorkId: input.previousWorkId,
    previousWorkName: input.previousWorkName,
    workId: input.workId,
    workName: input.workName,
    ...(input.previousScratchUri ? { previousScratchUri: input.previousScratchUri } : {}),
    actor: input.actor,
  };
  return {
    kind: "work_switched",
    scope: { kind: "thread", threadId: input.threadId },
    message: workSwitchedNoticeMessage(data),
    data,
  };
}

export function formatWorkSwitchedNotice(data: Record<string, unknown>): string | null {
  if (data.actor !== "writer" && data.actor !== "model") return null;
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
