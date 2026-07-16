/** Durable safety notices shared by model-context and writer transports. */
export type NoticeScope =
  | { kind: "thread"; threadId: string }
  | { kind: "document"; documentId: string };

export interface NoticeInput {
  kind: string;
  scope: NoticeScope;
  message: string;
  data: Record<string, unknown>;
  writerVisible: boolean;
}

export interface Notice extends NoticeInput {
  id: number;
  createdAt: Date;
}

export interface WriterNoticeEvent {
  documentId: string;
  kind: string;
  message: string;
  data: Record<string, unknown>;
}

export type WriterNoticeListener = (event: WriterNoticeEvent) => void;

export interface NoticePort {
  record(input: NoticeInput): Promise<void>;
  drainForModelContext(threadId: string, activeDocumentIds: readonly string[]): Promise<Notice[]>;
  drainForWriter(documentId: string): Promise<Notice[]>;
  subscribeWriterVisible(listener: WriterNoticeListener): () => void;
}

export { createDrizzleNoticePort } from "./adapters/drizzle-notice-port.js";
