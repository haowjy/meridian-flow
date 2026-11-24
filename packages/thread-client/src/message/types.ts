import type { CanonicalContextUri, ProjectId, UserId, WorkId } from "@meridian/contracts";
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { WorkHandle } from "@meridian/contracts/works";

export type StableReferenceAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workHandle: WorkHandle | null }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string; rootThreadRef: string }
  | { kind: "chat"; projectId: ProjectId; chatId: string; chatRef: string | null };

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

export type RestorableReference =
  | (Extract<MessageReference, { kind: "document" }> & {
      uri: CanonicalContextUri;
      fileType: string;
      authority: StableReferenceAuthority;
    })
  | (Extract<MessageReference, { kind: "folder" }> & { uri: CanonicalContextUri });

export type MessageSkill = { slug: string; name: string; description: string };

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
export type BuiltMessageDoc = { type: "doc"; content: readonly MessageParagraphNode[] };

export type SerializedMessage = {
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  activatedSkillSlugs: readonly string[];
};
