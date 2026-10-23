/** Messages shared by the Markdown worker and its main-thread adapter. */

import type { NodePath } from "./markdown-parse-session";

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
      openCode: NodePath;
    }
  | { type: "error"; streamId: string; generation: number; seq: number; message: string };
