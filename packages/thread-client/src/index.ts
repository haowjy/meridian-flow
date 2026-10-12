/** Platform-neutral client behavior shared by the app and ./mf. */

export { buildMessageDoc } from "./message/build";
export {
  imageCapable,
  referenceOccurrence,
  referenceSpelling,
  skillOccurrence,
} from "./message/occurrences";
export { serializeMessageDoc } from "./message/serialize";
export type {
  BuiltMessageDoc,
  MessageDoc,
  MessageHardBreakNode,
  MessageInlineNode,
  MessageParagraphNode,
  MessageReference,
  MessageReferenceNode,
  MessageSkill,
  MessageSkillNode,
  MessageTextNode,
  SerializedMessage,
} from "./message/types";

export type * from "./socket/socket-ports";
export { ThreadSocketClient, type ThreadSocketClientOptions } from "./socket/thread-socket-client";
export type * from "./socket/thread-transport";
