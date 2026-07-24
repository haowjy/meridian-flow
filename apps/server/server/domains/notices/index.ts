/** Durable notices injected into model context before the next request. */
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

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
