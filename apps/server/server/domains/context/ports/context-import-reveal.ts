/** The import's last step: every planned node becomes a `create` record, in one admission. */
import type { AheadMint } from "@meridian/agent-edit/integration";
import type { StoredDocumentProperties } from "@meridian/contracts";
import type { ContextImportArea } from "./context-import-read.js";

export type ImportRevealNode = {
  id: string;
  area: ContextImportArea;
  /** A planned folder's id, or the destination folder it lands in; null for the area's top. */
  parentId: string | null;
  /** The name as stored: a document's carries its extension unless it is prose. */
  name: string;
} & (
  | { kind: "folder" }
  | {
      kind: "document";
      filetype: string;
      aliases: string[];
      properties?: StoredDocumentProperties;
      /** Links to documents that do not exist yet, registered in the admitting transaction. */
      aheadMints: readonly AheadMint[];
    }
  | {
      kind: "file";
      blob: { storageKey: string; mime: string; size: number };
      hasPreview: boolean;
    }
);

export interface ContextImportReveal {
  /**
   * Joins the caller's transaction. Never refused: a name taken meanwhile is numbered, and a
   * destination folder deleted meanwhile stands again (the list's replay). Each document's first
   * text is already in the journal under its id.
   */
  reveal(input: { projectId: string; nodes: readonly ImportRevealNode[] }): Promise<void>;
}
