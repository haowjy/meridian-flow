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

export type SkillAvailableNoticeData = {
  slug: string;
  name: string;
  description: string;
};

export type SkillAvailableNotice = NoticeInput & {
  kind: "skill_available";
  scope: { kind: "thread"; threadId: ThreadId };
  data: SkillAvailableNoticeData;
};

export function createSkillAvailableNotice(input: {
  threadId: ThreadId;
  slug: string;
  name: string;
  description: string;
}): SkillAvailableNotice {
  const data: SkillAvailableNoticeData = {
    slug: input.slug,
    name: input.name,
    description: input.description,
  };
  return {
    kind: "skill_available",
    scope: { kind: "thread", threadId: input.threadId },
    message: skillAvailableNoticeMessage(data),
    data,
  };
}

export function formatSkillAvailableNotice(data: Record<string, unknown>): string | null {
  const name = nonEmptyString(data.name);
  return name
    ? skillAvailableNoticeMessage({
        name,
        description: typeof data.description === "string" ? data.description : "",
      })
    : null;
}

function workSwitchedNoticeMessage(data: { previousWorkName: string; workName: string }): string {
  return `This conversation's Work switched from ${JSON.stringify(data.previousWorkName)} to ${JSON.stringify(data.workName)}.`;
}

function skillAvailableNoticeMessage(data: { name: string; description: string }): string {
  const description = data.description.replace(/\s+/g, " ").trim();
  return description
    ? `The skill ${JSON.stringify(data.name)} is available to be used. ${description}`
    : `The skill ${JSON.stringify(data.name)} is available to be used.`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
