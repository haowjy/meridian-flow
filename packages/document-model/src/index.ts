export { type ApplyOpsOptions, type ApplyOpsResult, applyOps, type ShapeOp } from "./apply-ops.js";
export {
  type ApplyOptions,
  applyBlocks,
  type BlockChange,
  type ChangeSelection,
  changedBlocks,
  discardBlocks,
  type PressChanges,
  type PressedChange,
  type PressOptions,
  type PressUndo,
  pendingRemovalVersion,
  selectChanges,
  undoPress,
} from "./changes.js";
export { type CommitAuthor, commitMessage, readCommitMessage } from "./commit-message.js";
export { decodeEnvelope, type Envelope, EnvelopeError, encodeEnvelope } from "./envelope.js";
export { inMap, inText, scoped } from "./handles.js";
export {
  editSince,
  holdsEdit,
  type StoredEdit,
  undoEdits,
  versionOf,
} from "./invert.js";
export { keyBetween, type Random } from "./order-key.js";
export {
  freshPeerId,
  freshServerPeerId,
  isServerPeer,
  type PeerId,
} from "./peer.js";
export {
  commentVisibility,
  emptyParagraphId,
  emptyParagraphOf,
  isDerivedEmpty,
  normalizeInline,
  normalizeMarks,
  type ReadSince,
  readDocument,
  readInline,
  shownUnits,
  structureValues,
  type TextUnit,
  textUnits,
  unitEditors,
  visibleComments,
} from "./read.js";
export {
  removedOnPath,
  restore,
  UNTRACKED_ORIGIN,
} from "./removals.js";
export {
  CorruptDocBytesError,
  HistoryCutoffError,
  type Imported,
  RoomDocs,
} from "./room-docs.js";
export {
  type Attrs,
  type BlockId,
  COMMENT_MARK,
  COMMENT_STYLE_PREFIX,
  type CommentBody,
  configureDoc,
  type DocKey,
  INLINE_STYLE,
  type InlineItem,
  type Marks,
  markNameOf,
  membersOf,
  type NodeRule,
  SENTINEL,
  type ShapeBlock,
  type ShapeSchema,
  STRUCTURE_KEY,
  STRUCTURE_MAPS,
  type StructureMap,
  type StyleExpand,
  sameValue,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
export {
  type Removal,
  removalOf,
  StructureView,
} from "./structure.js";
export {
  type Edit,
  type EditValues,
  putBackValues,
  readOf,
  type SetValue,
  type TextOp,
  type TextSpan,
  takeBack,
  valuesOf,
} from "./take-back.js";
export { replaceText, type TextRules } from "./text.js";
export {
  batchEnd,
  type DocVersion,
  decodeDocVersion,
  decodeRoomVersion,
  docCovers,
  docVersion,
  encodeDocVersion,
  encodeRoomVersion,
  mergeVersion,
  plainVersion,
  type RoomVersion,
  updateEnd,
  versionCovers,
  withVector,
} from "./version.js";
export {
  commitStructure,
  type DocChange,
  encodeChanges,
  StructureWriter,
  type WriteOptions,
  writeDocument,
  writeText,
} from "./write.js";
