/** Durable notices injected into model context before the next request. */
export type NoticeScope =
  | { kind: "thread"; threadId: string }
  | { kind: "document"; documentId: string };

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
  drainForModelContext(threadId: string, activeDocumentIds: readonly string[]): Promise<Notice[]>;
}

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
