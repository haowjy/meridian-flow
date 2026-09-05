/** Pure Composer document schema, serialization, and exact selection snapshots. */
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UploadIntakeResult,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import type { Editor, JSONContent } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import type { AuthoritativeReference } from "@/core/completion";

export type ComposerDraftRevision = number;
export type ComposerSelection = Readonly<{ anchor: number; head: number }>;
export type ComposerOwnedUpload = Readonly<{
  intakeId: string;
  documentId: string;
  uri: UploadIntakeResult["uri"];
  locationRevision: string;
}>;
export type ComposerDraftSnapshot = Readonly<{
  revision: ComposerDraftRevision;
  doc: JSONContent;
  selection: ComposerSelection;
  ownedUploads: readonly ComposerOwnedUpload[];
}>;
export type ComposerDraftChange = Readonly<{
  /** Derived convenience projection; snapshot is the authoring authority. */
  text: string;
  snapshot: ComposerDraftSnapshot;
}>;
export type ComposerSubmitEnvelope = Readonly<{
  submissionId: string;
  acceptedRevision: ComposerDraftRevision;
  text: string;
  blocks: readonly UserMessageBlock[];
  references: readonly SubmittedReference[];
  draft: ComposerDraftSnapshot;
}>;

function jsonNodeSize(node: JSONContent): number {
  if (node.type === "text") return node.text?.length ?? 0;
  if (!node.content) return 1;
  return 2 + node.content.reduce((size, child) => size + jsonNodeSize(child), 0);
}

/** Preserve a failed submitted document before everything authored after it. */
export function mergeComposerDraftSnapshots(
  submitted: ComposerDraftSnapshot,
  later: ComposerDraftSnapshot,
): ComposerDraftSnapshot {
  const prefix = [...(submitted.doc.content ?? []), { type: "paragraph" }];
  const offset = prefix.reduce((size, child) => size + jsonNodeSize(child), 0);
  const uploads = new Map(
    [...submitted.ownedUploads, ...later.ownedUploads].map((upload) => [upload.intakeId, upload]),
  );
  return {
    revision: Math.max(submitted.revision, later.revision) + 1,
    doc: { type: "doc", content: [...prefix, ...(later.doc.content ?? [])] },
    selection: {
      anchor: later.selection.anchor + offset,
      head: later.selection.head + offset,
    },
    ownedUploads: [...uploads.values()],
  };
}

export type ComposerReferenceAttrs = AuthoritativeReference & {
  spelling: string;
  imageCapable: boolean;
  upload: ComposerOwnedUpload | null;
};
export type ComposerPendingUploadAttrs = {
  intakeId: string;
  name: string;
  state: "pending" | "failed";
  error: string | null;
};

export const ComposerReferenceNode = Node.create({
  name: "composerReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ reference: { default: null } }),
  parseHTML: () => [{ tag: "span[data-composer-reference]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.reference as ComposerReferenceAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-reference": "",
        role: "button",
        tabindex: "0",
        "aria-label": `${value.fileType}: ${value.label}`,
      }),
      value.spelling,
    ];
  },
});

export const ComposerUploadNode = Node.create({
  name: "composerUpload",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ upload: { default: null } }),
  parseHTML: () => [{ tag: "span[data-composer-upload]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.upload as ComposerPendingUploadAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-upload": value.state,
        "data-intake-id": value.intakeId,
        role: "button",
        tabindex: "0",
        "aria-label": `${value.state} upload: ${value.name}`,
      }),
      value.state === "pending" ? `${value.name}…` : `${value.name} (failed)`,
    ];
  },
});

export type ComposerOwnedUploadReference = Readonly<{
  upload: ComposerOwnedUpload;
  authority: Extract<AuthoritativeReference["authority"], { kind: "work" | "none" }>;
}>;

export function composerOwnedUploadReferences(doc: JSONContent): ComposerOwnedUploadReference[] {
  const references: ComposerOwnedUploadReference[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === "composerReference") {
      const value = node.attrs?.reference as ComposerReferenceAttrs;
      if (value.upload && (value.authority.kind === "work" || value.authority.kind === "none"))
        references.push({ upload: value.upload, authority: value.authority });
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(doc);
  return references;
}

export function composerReferenceContent(reference: ComposerReferenceAttrs): JSONContent {
  return { type: "composerReference", attrs: { reference } };
}

export function composerSelection(selection: Selection): ComposerSelection {
  return { anchor: selection.anchor, head: selection.head };
}

export function restoreComposerSelection(editor: Editor, selection: ComposerSelection): void {
  editor.view.dispatch(
    editor.state.tr.setSelection(
      TextSelection.create(editor.state.doc, selection.anchor, selection.head),
    ),
  );
}

export function serializeComposerDraft(
  doc: JSONContent,
  revision = 0,
  selection: ComposerSelection = { anchor: 1, head: 1 },
): ComposerSubmitEnvelope {
  const blocks: UserMessageBlock[] = [];
  const references = new Map<string, SubmittedReference>();
  const ownedUploads: ComposerOwnedUpload[] = [];
  let text = "";
  const emitText = (value: string) => {
    if (!value) return;
    text += value;
    const last = blocks.at(-1);
    if (last?.type === "text") last.text += value;
    else blocks.push({ type: "text", text: value });
  };
  const walk = (node: JSONContent, top = false) => {
    if (node.type === "text") return emitText(node.text ?? "");
    if (node.type === "hardBreak") return emitText("\n");
    if (node.type === "composerReference") {
      const value = node.attrs?.reference as ComposerReferenceAttrs;
      const occurrence: ReferenceOccurrence = {
        type: "reference",
        text: value.spelling,
        documentId: value.documentId,
        uri: value.uri,
      };
      blocks.push(occurrence);
      text += value.spelling;
      if (value.imageCapable)
        blocks.push({ type: "image", documentId: value.documentId, uri: value.uri });
      const key = `${value.documentId}\0${value.uri}`;
      const proposed: SubmittedReference = value.upload
        ? {
            documentId: value.documentId,
            uri: value.uri,
            purpose: "draft-upload",
            intakeId: value.upload.intakeId,
          }
        : { documentId: value.documentId, uri: value.uri, purpose: "reference" };
      if (!references.has(key) || proposed.purpose === "draft-upload")
        references.set(key, proposed);
      if (
        value.upload &&
        !ownedUploads.some((upload) => upload.intakeId === value.upload?.intakeId)
      )
        ownedUploads.push(value.upload);
      return;
    }
    const children = node.content ?? [];
    children.forEach((child, index) => {
      walk(child);
      if (top && node.type === "doc" && child.type === "paragraph" && index < children.length - 1)
        emitText("\n");
    });
  };
  walk(doc, true);
  const draft = { revision, doc, selection, ownedUploads } as const;
  return {
    submissionId: crypto.randomUUID(),
    acceptedRevision: revision,
    text,
    blocks,
    references: [...references.values()],
    draft,
  };
}

export function plainComposerDoc(text: string): JSONContent {
  const lines = text.split("\n");
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: lines.flatMap((line, index) => [
          ...(index ? [{ type: "hardBreak" }] : []),
          ...(line ? [{ type: "text", text: line }] : []),
        ]),
      },
    ],
  };
}
