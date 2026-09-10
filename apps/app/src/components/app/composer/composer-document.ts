/** Pure Composer document schema, serialization, and exact selection snapshots. */
import type {
  ReferenceOccurrence,
  SubmittedReference,
  UploadIntakeResult,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { formatWikilink, wikilinkTarget } from "@meridian/markup";
import type { Editor, JSONContent } from "@tiptap/core";
import { mergeAttributes, Node } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { AuthoritativeReference } from "@/core/completion";
import { referenceUriForAuthority } from "@/core/completion";
import { internalClipboardTarget } from "@/core/editor/links";

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
  /** Per-occurrence prose, independent of the catalog title and stable identity. */
  displayText?: string;
  imageCapable: boolean;
  upload: ComposerOwnedUpload | null;
};
export type ComposerPendingUploadAttrs = {
  intakeId: string;
  name: string;
  state: "pending" | "failed";
  error: string | null;
};

/** HTML clipboard metadata is untrusted input; turn admission still authorizes identity. */
function parseClipboardReference(raw: string | null): ComposerReferenceAttrs | null {
  if (!raw) return null;
  let value: ComposerReferenceAttrs;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    ![value.documentId, value.uri, value.fileType, value.label, value.spelling].every(
      (field) => typeof field === "string",
    ) ||
    (value.displayText !== undefined && typeof value.displayText !== "string") ||
    typeof value.imageCapable !== "boolean"
  )
    return null;
  const documentId = parseRequestId(value.documentId);
  if (!documentId) return null;
  const rawAuthority = value.authority;
  if (!rawAuthority || typeof rawAuthority !== "object") return null;
  let authority: ComposerReferenceAttrs["authority"];
  switch (rawAuthority.kind) {
    case "user": {
      const userId = parseRequestId(rawAuthority.userId);
      if (!userId) return null;
      authority = { kind: "user", userId };
      break;
    }
    case "project":
    case "none": {
      const projectId = parseRequestId(rawAuthority.projectId);
      if (!projectId) return null;
      authority = { kind: rawAuthority.kind, projectId };
      break;
    }
    case "work": {
      const projectId = parseRequestId(rawAuthority.projectId);
      const workId = parseRequestId(rawAuthority.workId);
      const workSlug = decodeWorkSlug(rawAuthority.workSlug);
      if (!projectId || !workId || !workSlug) return null;
      authority = { kind: "work", projectId, workId, workSlug };
      break;
    }
    default:
      return null;
  }
  const uri = referenceUriForAuthority(value.uri, authority);
  const classification = classifyFiletype(value.fileType);
  if (!uri || classification.kind === "unknown") return null;
  // A copied occurrence owns no upload lifecycle; capability derives from the
  // file classification, not an independently supplied clipboard boolean.
  return {
    documentId,
    authority,
    uri,
    fileType: value.fileType,
    label: value.label,
    spelling: value.spelling,
    ...(value.displayText !== undefined ? { displayText: value.displayText } : {}),
    upload: null,
    imageCapable: classification.kind === "binary" && classification.fileType === "image",
  };
}

export const ComposerReferenceNode = Node.create({
  name: "composerReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    reference: {
      default: null,
      rendered: false,
      parseHTML: (element) =>
        parseClipboardReference(element.getAttribute("data-composer-reference")),
    },
  }),
  parseHTML: () => [
    {
      tag: "span[data-composer-reference]",
      getAttrs: (element) =>
        parseClipboardReference(element.getAttribute("data-composer-reference")) ? {} : false,
    },
  ],
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          transformPastedHTML(html) {
            const container = document.createElement("div");
            container.innerHTML = html;
            for (const element of container.querySelectorAll("[data-meridian-link]")) {
              if (parseClipboardReference(element.getAttribute("data-composer-reference")))
                continue;
              // Manuscript marks carry a target, not admitted attachment identity.
              // Preserve their Markdown rather than inventing a Composer attachment.
              const target = internalClipboardTarget(element.getAttribute("data-meridian-link"));
              if (!target) continue;
              element.replaceWith(
                document.createTextNode(
                  formatWikilink(
                    wikilinkTarget(target) ?? target,
                    element.textContent ?? undefined,
                  ),
                ),
              );
            }
            return container.innerHTML;
          },
        },
      }),
    ];
  },
  renderText: ({ node }) => {
    const value = node.attrs.reference as ComposerReferenceAttrs;
    return formatWikilink(value.uri, value.displayText ?? value.label);
  },
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.reference as ComposerReferenceAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-reference": JSON.stringify({ ...value, upload: null }),
        "data-meridian-link": formatWikilink(value.uri),
        role: "link",
        tabindex: "0",
        "aria-label": value.displayText ?? value.label,
        "aria-disabled": "true",
      }),
      value.displayText ?? value.label,
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
  parseHTML: () => [{ tag: "[data-composer-upload]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.upload as ComposerPendingUploadAttrs;
    return [
      value.state === "failed" ? "button" : "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-upload": value.state,
        "data-intake-id": value.intakeId,
        type: value.state === "failed" ? "button" : undefined,
        role: value.state === "pending" ? "status" : undefined,
        contenteditable: "false",
        "aria-label": `${value.state} upload: ${value.name}`,
      }),
      value.state === "pending"
        ? `${value.name}…`
        : `${value.name} (${value.error ?? "Upload failed"})`,
    ];
  },
});

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
      const spelling =
        value.displayText === undefined
          ? value.spelling
          : formatWikilink(wikilinkTarget(value.spelling) ?? value.uri, value.displayText);
      const occurrence: ReferenceOccurrence = {
        type: "reference",
        text: spelling,
        documentId: value.documentId,
        uri: value.uri,
      };
      blocks.push(occurrence);
      text += spelling;
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
