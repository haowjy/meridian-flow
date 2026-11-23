export { type ApplyOpsResult, applyOps, type ShapeOp } from "./apply-ops.js";
export { decodeEnvelope, type Envelope, EnvelopeError, encodeEnvelope } from "./envelope.js";
export { inMap, inText, scoped } from "./handles.js";
export { compareOrder, keyBetween, orderKeys, type Random } from "./order-key.js";
export {
  freshPeerId,
  freshServerPeerId,
  isServerPeer,
  type PeerId,
} from "./peer.js";
export {
  commentVisibility,
  derivedEmptyParent,
  emptyParagraphId,
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
  isOrderKey,
  type Removal,
  removalOf,
  StructureView,
} from "./structure.js";
export {
  type Edit,
  type EditValues,
  editStays,
  leftOf,
  noteEdit,
  opsBetween,
  putBackValues,
  type SetValue,
  type TakenBack,
  type TextOp,
  type TextSpan,
  takeBackMessage,
  takenBack,
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
export {
  commitStructure,
  type DocChange,
  encodeChanges,
  StructureWriter,
  setCommentBody,
  type WriteOptions,
  writeDocument,
  writeText,
} from "./write.js";
