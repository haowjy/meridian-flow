/** Messages shared by the Markdown worker and its main-thread cache. */

export type OpenCodePath = { block: number; path: number[] } | null;

export type MarkdownWorkerRequest =
  | { type: "parse"; streamId: string; generation: number; seq: number; source: string }
  | { type: "release"; streamId: string; generation: number };

export type MarkdownWorkerResponse =
  | {
      type: "result";
      streamId: string;
      generation: number;
      seq: number;
      source: string;
      keys: string[];
      nodes: Record<string, unknown>;
      evicted: string[];
      openCode: OpenCodePath;
    }
  | { type: "error"; streamId: string; generation: number; seq: number; message: string };
