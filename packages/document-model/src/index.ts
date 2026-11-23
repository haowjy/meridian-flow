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
export { decodeEnvelope, type Envelope, EnvelopeError, encodeEnvelope } from "./envelope.js";
export { inMap, inText, scoped } from "./handles.js";
export {
  editSince,
  frontiersOf,
  holdsEdit,
  loadEdit,
  type StoredEdit,
  takeBack,
  undoEdits,
  versionOf,
} from "./invert.js";
export { compareOrder, keyBetween, orderKeys, type Random } from "./order-key.js";
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
  RoomDocsFreedError,
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
  type NodeRule,
  overrideMap,
  pieceEnds,
  pieceKey,
  SENTINEL,
  SETTLED_MAP,
  type ShapeBlock,
  type ShapeSchema,
  STRUCTURE_KEY,
  STRUCTURE_MAPS,
  type StructureMap,
  type StyleExpand,
  sameValue,
  settledKey,
  storedAttrs,
  TEXT_KEY,
} from "./shape.js";
export {
  isOrderKey,
  type Removal,
  removalOf,
  StructureView,
} from "./structure.js";
export {
  deletedBetween,
  type Edit,
  type EditValues,
  editStays,
  memberOf,
  noteEdit,
  type OpSpans,
  opsBetween,
  putBackValues,
  type SetValue,
  type TextOp,
  type TextSpan,
  takeBackMessage,
  textSince,
  valuesOf,
} from "./take-back.js";
export { replaceText, type TextRules } from "./text.js";
export {
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
export { type WordPart, wordDiff } from "./word-diff.js";
export {
  commitStructure,
  type DocChange,
  encodeChanges,
  type MovedPiece,
  type Piece,
  StructureWriter,
  setCommentBody,
  type WriteOptions,
  writeDocument,
  writeText,
} from "./write.js";
