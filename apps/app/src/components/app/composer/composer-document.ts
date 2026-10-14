/** TipTap Composer schema, clipboard, draft ownership, and exact selection snapshots. */

import type {
  SubmittedReference,
  UploadIntakeResult,
  UserMessageBlock,
} from "@meridian/contracts/protocol";
import { classifyFiletype } from "@meridian/contracts/protocol";
import { parseRequestId } from "@meridian/contracts/request-id";
import { decodeWorkSlug } from "@meridian/contracts/works";
import { formatMarkdownLink } from "@meridian/markup/links";
import {
  imageCapable,
  type MessageReference,
  type MessageSkill,
  referenceSpelling,
  serializeMessageDoc,
} from "@meridian/thread-client";
import type { Editor, JSONContent } from "@tiptap/core";
import { getSchema, mergeAttributes, Node } from "@tiptap/core";
import type { Selection } from "@tiptap/pm/state";
import { Plugin, Selection as PMSelection, TextSelection } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import StarterKit from "@tiptap/starter-kit";
import type { AuthoritativeReference } from "@/core/completion";
import { referenceUriForAuthority } from "@/core/completion";
import {
  clipboardLinkAddress,
  internalClipboardTarget,
  LINK_ADDRESS_ATTRIBUTE,
} from "@/core/editor/links";

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
  activatedSkillSlugs: readonly string[];
}>;

export type ComposerReferenceAttrs = AuthoritativeReference &
  MessageReference & {
    upload: ComposerOwnedUpload | null;
  };
export type ComposerPendingUploadAttrs = {
  intakeId: string;
  name: string;
  state: "pending" | "failed";
  error: string | null;
};
export type ComposerSkillAttrs = MessageSkill;

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
    ![value.documentId, value.uri, value.fileType, value.label].every(
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
    case "project": {
      const projectId = parseRequestId(rawAuthority.projectId);
      if (!projectId) return null;
      authority = { kind: "project", projectId };
      break;
    }
    case "work": {
      const projectId = parseRequestId(rawAuthority.projectId);
      const workId = parseRequestId(rawAuthority.workId);
      const workSlug =
        rawAuthority.workSlug === null ? null : decodeWorkSlug(rawAuthority.workSlug);
      if (!projectId || !workId || (rawAuthority.workSlug !== null && !workSlug)) return null;
      authority = { kind: "work", projectId, workId, workSlug };
      break;
    }
    case "lineage": {
      const projectId = parseRequestId(rawAuthority.projectId);
      const rootThreadId = parseRequestId(rawAuthority.rootThreadId);
      const rootThreadRef = rawAuthority.rootThreadRef;
      if (!projectId || !rootThreadId || typeof rootThreadRef !== "string") return null;
      authority = { kind: "lineage", projectId, rootThreadId, rootThreadRef };
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
    ...(value.displayText !== undefined ? { displayText: value.displayText } : {}),
    upload: null,
    imageCapable: imageCapable(value.fileType),
  };
}

function parseClipboardSkill(raw: string | null): ComposerSkillAttrs | null {
  if (!raw) return null;
  let value: ComposerSkillAttrs;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.slug !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !value.slug
  )
    return null;
  return { slug: value.slug, name: value.name, description: value.description };
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
              // Chat has no folder, so a recorded address (the full Context URI
              // the link named where it was copied) wins over a relative href.
              const target =
                clipboardLinkAddress(element.getAttribute(LINK_ADDRESS_ATTRIBUTE)) ??
                internalClipboardTarget(element.getAttribute("data-meridian-link"));
              if (!target) continue;
              element.replaceWith(
                document.createTextNode(formatMarkdownLink(element.textContent ?? target, target)),
              );
            }
            return container.innerHTML;
          },
        },
      }),
    ];
  },
  renderText: ({ node }) => referenceSpelling(node.attrs.reference as ComposerReferenceAttrs),
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs.reference as ComposerReferenceAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-reference": JSON.stringify({ ...value, upload: null }),
        "data-meridian-link": value.uri,
        role: "link",
        tabindex: "0",
        "aria-label": value.displayText ?? value.label,
        "aria-disabled": "true",
      }),
      value.displayText ?? value.label,
    ];
  },
});

export const ComposerSkillNode = Node.create({
  name: "composerSkill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    slug: { default: "", rendered: false },
    name: { default: "", rendered: false },
    description: { default: "", rendered: false },
  }),
  parseHTML: () => [
    {
      tag: "span[data-composer-skill]",
      getAttrs: (element) =>
        parseClipboardSkill(
          element instanceof HTMLElement ? element.getAttribute("data-composer-skill") : null,
        ) ?? false,
    },
  ],
  renderText: ({ node }) => `/${(node.attrs as ComposerSkillAttrs).slug}`,
  renderHTML: ({ node, HTMLAttributes }) => {
    const value = node.attrs as ComposerSkillAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-skill": JSON.stringify({
          slug: value.slug,
          name: value.name,
          description: value.description,
        }),
      }),
      `/${value.slug}`,
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

export function composerSkillContent(skill: ComposerSkillAttrs): JSONContent {
  return { type: "composerSkill", attrs: skill };
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
  const ownedUploads: ComposerOwnedUpload[] = [];
  const seenIntakes = new Set<string>();
  const message = serializeMessageDoc(doc, {
    onReference(reference) {
      const upload = (reference as ComposerReferenceAttrs).upload;
      if (upload && !seenIntakes.has(upload.intakeId)) {
        seenIntakes.add(upload.intakeId);
        ownedUploads.push(upload);
      }
    },
  });
  const draft = { revision, doc, selection, ownedUploads } as const;
  return {
    submissionId: crypto.randomUUID(),
    acceptedRevision: revision,
    ...message,
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

let restorableDraftSchema: ReturnType<typeof getSchema> | null = null;

/** Validate stored authoring state, excluding uploads whose bytes lived in memory. */
export function parseRestorableComposerDraft(value: unknown): ComposerDraftSnapshot | null {
  try {
    if (!value || typeof value !== "object") return null;
    const snapshot = value as ComposerDraftSnapshot;
    if (
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision < 0 ||
      !Array.isArray(snapshot.ownedUploads) ||
      snapshot.doc?.type !== "doc"
    )
      return null;
    const clean = (node: JSONContent): JSONContent | null => {
      if (!node || typeof node !== "object" || typeof node.type !== "string")
        throw new Error("Invalid node");

      if (node.type === "composerReference") {
        const reference = parseClipboardReference(JSON.stringify(node.attrs?.reference));
        if (!reference) throw new Error("Invalid reference");
        const upload = node.attrs?.reference?.upload as ComposerOwnedUpload | null;
        if (
          upload &&
          (typeof upload.intakeId !== "string" ||
            upload.documentId !== reference.documentId ||
            upload.uri !== reference.uri ||
            typeof upload.locationRevision !== "string")
        )
          throw new Error("Invalid upload");
        return composerReferenceContent({ ...reference, upload });
      }
      if (node.type === "composerSkill" && !parseClipboardSkill(JSON.stringify(node.attrs)))
        throw new Error("Invalid skill");
      return {
        ...node,
        ...(node.content
          ? {
              content: node.content
                .map(clean)
                .filter((child): child is JSONContent => child !== null),
            }
          : {}),
      };
    };
    const doc = clean(snapshot.doc);
    if (!doc) return null;
    restorableDraftSchema ??= getSchema([
      StarterKit,
      ComposerReferenceNode,
      ComposerSkillNode,
      ComposerUploadNode,
    ]);
    const parsed = restorableDraftSchema.nodeFromJSON(doc);
    parsed.check();
    const saved = snapshot.selection;
    const valid =
      saved &&
      [saved.anchor, saved.head].every(
        (position) =>
          Number.isSafeInteger(position) &&
          position >= 0 &&
          position <= parsed.content.size &&
          parsed.resolve(position).parent.inlineContent,
      );
    const selection = valid
      ? TextSelection.create(parsed, saved.anchor, saved.head)
      : PMSelection.atStart(parsed);
    const transform = new Transform(parsed);
    const uploads: { position: number; size: number }[] = [];
    parsed.descendants((node, position) => {
      if (node.type.name === "composerUpload") uploads.push({ position, size: node.nodeSize });
    });
    for (const { position, size } of uploads.reverse()) transform.delete(position, position + size);
    const mapped = selection.map(transform.doc, transform.mapping);
    return serializeComposerDraft(
      transform.doc.toJSON(),
      snapshot.revision,
      composerSelection(mapped),
    ).draft;
  } catch {
    return null;
  }
}
