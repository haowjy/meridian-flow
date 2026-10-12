/** Plain JSON authoring shapes, independent of any editor or platform. */
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UserMessageBlock,
} from "@meridian/contracts/protocol";

/** Only the fields message serialization consumes; hosts may carry more metadata. */
export type MessageReference = {
  documentId: ReferenceOccurrence["documentId"];
  uri: string;
  label: string;
  displayText?: string;
  imageCapable: boolean;
  upload?: { intakeId: string } | null;
};

export type MessageSkill = { slug: string; name: string; description: string };

/** A permissive tree so editor JSON and non-editor documents share the same walk. */
export type MessageDoc = {
  type?: string;
  attrs?: Record<string, unknown>;
  text?: string;
  content?: readonly MessageDoc[];
};

export type MessageSkillNode = {
  type: "composerSkill";
  attrs: MessageSkill;
};
export type MessageReferenceNode = {
  type: "composerReference";
  attrs: { reference: MessageReference };
};
export type MessageTextNode = { type: "text"; text: string };
export type MessageHardBreakNode = { type: "hardBreak" };
export type MessageInlineNode =
  | MessageSkillNode
  | MessageReferenceNode
  | MessageTextNode
  | MessageHardBreakNode;
export type MessageParagraphNode = { type: "paragraph"; content?: readonly MessageInlineNode[] };
/** Composer-valid construction boundary; serializer input also accepts editor JSON. */
export type BuiltMessageDoc = { type: "doc"; content: readonly MessageParagraphNode[] };

export type SerializedMessage = {
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  activatedSkillSlugs: readonly string[];
};
