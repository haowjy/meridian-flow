export { runBackgroundRetrieval } from "./backgroundRetrieval";
export type { RetrievalMode } from "./backgroundRetrieval";
export { reconcileSelectionIfMissing } from "./selectionReconciliation";
export {
  getTerminalErrorAction,
  shouldPruneLocalEntity,
  shouldClearActiveSelection,
} from "./terminalErrorPolicy";
export {
  sanitizeTreeSnapshot,
  normalizeTreeState,
} from "./treeSnapshotNormalization";
export type {
  RetrievalOperationKey,
  TerminalErrorAction,
} from "./terminalErrorPolicy";
export type {
  SanitizeTreeSnapshotArgs,
  SanitizedTreeSnapshot,
  NormalizedTreeState,
} from "./treeSnapshotNormalization";
