/** Durable notices injected into model context before the next request. */
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";

export type NoticeScope = { kind: "thread"; threadId: string };

export interface NoticeInput {
  kind: string;
  scope: NoticeScope;
  message: string;
  data: Record<string, unknown>;
}

export interface Notice extends NoticeInput {
  id: number;
  createdAt: Date;
}

export interface NoticePort {
  record(input: NoticeInput): Promise<void>;
  drainForModelContext(threadId: string): Promise<Notice[]>;
}

export type WriterWorkSwitchedNoticeData = {
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
  actor: "writer";
};

export type WriterWorkSwitchedNotice = NoticeInput & {
  kind: "work_switched";
  scope: { kind: "thread"; threadId: ThreadId };
  data: WriterWorkSwitchedNoticeData;
};

export function createWriterWorkSwitchedNotice(input: {
  threadId: ThreadId;
  previousWorkId: WorkId;
  previousWorkName: string;
  workId: WorkId;
  workName: string;
}): WriterWorkSwitchedNotice {
  const data: WriterWorkSwitchedNoticeData = {
    previousWorkId: input.previousWorkId,
    previousWorkName: input.previousWorkName,
    workId: input.workId,
    workName: input.workName,
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
    ? workSwitchedNoticeMessage({ previousWorkName, workName })
    : null;
}

function workSwitchedNoticeMessage(data: { previousWorkName: string; workName: string }): string {
  return `The writer switched this conversation's Work from ${JSON.stringify(data.previousWorkName)} to ${JSON.stringify(data.workName)} before this message.`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
