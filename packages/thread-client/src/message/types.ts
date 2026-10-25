/** Plain JSON authoring shapes, independent of any editor or platform. */
import type { CanonicalContextUri, ProjectId, UserId, WorkId } from "@meridian/contracts";
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { WorkHandle } from "@meridian/contracts/works";

/** The stable owner of a referenced document: what survives a rename of its URI. */
export type StableReferenceAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workHandle: WorkHandle | null }
  /** A No Work chat's Scratch: the lineage by its first chat's id, and the handle its URI spells. */
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string; rootThreadRef: string }
  /** A chat's uploads: the chat by id, and the handle its URI spells (null before the chat exists). */
  | { kind: "chat"; projectId: ProjectId; chatId: string; chatRef: string | null };

/** Only the fields message serialization consumes; hosts may carry more metadata. */
export type MessageReference =
  | {
      kind: "document";
      documentId: Extract<ReferenceOccurrence, { kind: "document" }>["documentId"];
      uri: string;
      label: string;
      displayText?: string;
      imageCapable: boolean;
      upload?: { intakeId: string } | null;
    }
  | {
      kind: "folder";
      folderId: Extract<ReferenceOccurrence, { kind: "folder" }>["folderId"];
      uri: string;
      label: string;
      displayText?: string;
    };

/**
 * A reference chip as the composer stores and restores it: what serialization consumes plus the
 * file type and owner. The app's draft parser requires every field, so a chip built anywhere
 * (the app, a hand-back) restores the same way.
 */
export type RestorableReference =
  | (Extract<MessageReference, { kind: "document" }> & {
      uri: CanonicalContextUri;
      fileType: string;
      authority: StableReferenceAuthority;
    })
  | (Extract<MessageReference, { kind: "folder" }> & { uri: CanonicalContextUri });

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
