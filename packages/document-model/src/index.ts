export { type ApplyOpsResult, applyOps, type ShapeOp } from "./apply-ops.js";
export { decodeEnvelope, type Envelope, EnvelopeError, encodeEnvelope } from "./envelope.js";
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
  CorruptDocBytesError,
  decodeRoomVersion,
  encodeRoomVersion,
  HistoryCutoffError,
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
export { StructureView } from "./structure.js";
export { replaceText, type TextRules } from "./text.js";
export {
  changeUpdate,
  commitStructure,
  type DocChange,
  StructureWriter,
  setCommentBody,
  type WriteOptions,
  writeDocument,
  writeText,
} from "./write.js";
