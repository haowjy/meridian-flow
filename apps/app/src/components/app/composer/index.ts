/** Public boundary for the shared message composer. */
export {
  Composer,
  type ComposerDraftChange,
  type ComposerDraftRevision,
  type ComposerDraftSnapshot,
  type ComposerHandle,
  type ComposerOwnedUpload,
  type ComposerProps,
  type ComposerSelection,
  type ComposerSubmitEnvelope,
  type ComposerUploadPort,
  type ComposerUploadScope,
  serializeComposerDraft,
} from "./Composer";
export type { ComposerChatCommand } from "./command";
export { type DroppedEntry, useFileDrop } from "./use-file-drop";
