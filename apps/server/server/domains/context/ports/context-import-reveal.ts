import type { AheadMint } from "@meridian/agent-edit/integration";
import type { StoredDocumentProperties } from "@meridian/contracts";
import type { ContextImportArea } from "./context-import-read.js";

export type ImportRevealNode = {
  id: string;
  area: ContextImportArea;
  parentId: string | null;
  name: string;
} & (
  | { kind: "folder" }
  | {
      kind: "document";
      filetype: string;
      aliases: string[];
      properties?: StoredDocumentProperties;
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
   * Joins the caller's transaction. Never refused: a name taken meanwhile becomes a twin, and a
   * destination folder deleted meanwhile stands again (the list's replay). Each document's first
   * text is already in its Live room under its id.
   */
  reveal(input: { projectId: string; nodes: readonly ImportRevealNode[] }): Promise<void>;
}
