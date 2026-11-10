import type { DraftOwnerHint } from "@meridian/contracts/protocol";

/** Project-domain lifecycle notification implemented by the context catalog adapter. */
export interface ContextCatalogLifecyclePort {
  /** Must persist lifecycle metadata in the caller's ambient transaction. */
  refreshProject(projectId: string): Promise<void>;
  /** Upsert only the named Work authority signals in their project scopes. */
  upsertWorkAuthorities(workIds: readonly string[]): Promise<void>;
  /** Wake the project's clients once the caller's transaction commits. Lossy, truth-free. */
  publishDraftOwnerHints(hints: readonly DraftOwnerHint[]): void;
}
