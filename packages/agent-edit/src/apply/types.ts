import type * as Y from "yjs";

export interface ResolvedSpan {
  start: number;
  end: number;
}

/**
 * Resolver → apply seam. Element references are live objects from one local Y.Doc;
 * a ResolvedEdit must never escape the call that created it or cross process/doc boundaries.
 */
export type ResolvedEdit = { documentId: string; file: string } & (
  | {
      kind: "text";
      element: Y.XmlElement;
      span: ResolvedSpan;
      newText: string;
    }
  | {
      kind: "insert";
      after?: Y.XmlElement;
      newText: string;
    }
  | {
      kind: "delete";
      element: Y.XmlElement;
    }
);

export type EditResolutionErrorCode =
  | "not_found"
  | "ambiguous_match"
  | "invalid_write"
  | "document_not_found";

export type ApplyErrorCode = EditResolutionErrorCode | "partial_failure" | "internal_error";

export interface ApplyEchoHunk {
  mode: "suppressed" | "truncated" | "full";
  blocks: string[];
}

export interface ConcurrentEditInfo {
  human: string[];
  agent: string[];
  collapsed?: boolean;
  reviewCommand?: string;
}

export type ApplyResult =
  | {
      ok: true;
      status: "success";
      documentId: string;
      file: string;
      echo: ApplyEchoHunk[];
      concurrentEdits?: ConcurrentEditInfo;
      changedBlocks?: string[];
      deletedBlocks?: string[];
    }
  | {
      ok: false;
      error: {
        code: ApplyErrorCode;
        message: string;
        details?: Record<string, unknown>;
        committedEdits?: number;
      };
    };
