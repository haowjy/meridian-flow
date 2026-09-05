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
  type ComposerSubmitOutcome,
  type ComposerUploadPort,
  type ComposerUploadScope,
  serializeComposerDraft,
} from "./Composer";
export { mergeComposerDraftSnapshots } from "./composer-document";
