import {
  type LinkHolder,
  type LinkResolution,
  parseLinkRef,
  qualifyContextUriByHolder,
  resolveDocumentHref,
  resolveStoredLinkAddress,
  spellStoredLink,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import type { DocumentLinkScope } from "@meridian/markup";
import { UNSPELLED_UPLOAD } from "@meridian/markup/links";
import { DOMSerializer, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

import { NestingDOMSerializer } from "../extensions/nesting";
import { assignPastedSlice, type LinkAssignmentDocument } from "./link-assignment";
import {
  type LinkAnswerCache,
  type LinkKey,
  linkKeyOfMark,
  pictureKeyOfNode,
} from "./link-resolution";

export const LINK_ADDRESS_ATTRIBUTE = "data-meridian-address";
export const LINK_REF_ATTRIBUTE = "data-meridian-ref";
export const LINK_PROJECT_ATTRIBUTE = "data-meridian-project";
export const LINK_KEPT_REF_ATTRIBUTE = "data-meridian-kept-ref";

const linkClipboardPluginKey = new PluginKey<LinkAnswerCache>("meridianLinkClipboard");

function linkHrefAddress(href: string, holderUri: string | null): string | null {
  const resolved = resolveStoredLinkAddress({ href }, holderUri);
  if (!resolved) return null;
  return storedHref(
    { kind: resolved.kind, uri: qualifyContextUriByHolder(resolved.uri, holderUri) },
    resolved.suffix,
  );
}

function currentLinkAddress(link: LinkKey, resolution: LinkAnswerCache | null): string | null {
  const entry = link.ref && resolution ? resolution.read(link) : null;
  const { suffix } = splitDocumentHrefSuffix(link.href);
  if (entry?.state === "document")
    return storedHref({ kind: "document", uri: entry.document.uri }, suffix);
  if (entry?.state === "folder")
    return storedHref({ kind: "folder", uri: entry.folder.uri }, suffix);
  return linkHrefAddress(link.href, resolution?.baseUri ?? null);
}

export function clipboardLinkAddress(value: string | null): string | null {
  if (!value) return null;
  const resolved = resolveDocumentHref(value, null);
  return resolved && storedHref(resolved, resolved.suffix) === value ? value : null;
}

export function clipboardLinkRef(value: string | null): string | null {
  return value && parseLinkRef(value) ? value : null;
}

const UPLOAD_PREFIX = "asset:";

export function clipboardUploadRef(value: string | null): string | null {
  if (!value?.startsWith(UPLOAD_PREFIX)) return null;
  return parseLinkRef(`doc:${value.slice(UPLOAD_PREFIX.length)}`)?.kind === "doc" ? value : null;
}

export function clipboardPictureRef(value: string | null): string | null {
  return value?.startsWith(UPLOAD_PREFIX) ? clipboardUploadRef(value) : clipboardLinkRef(value);
}

function uploadDocument(
  src: string,
  resolution: LinkAnswerCache | null,
): LinkAssignmentDocument | null {
  if (!src.startsWith(UPLOAD_PREFIX)) return null;
  const documentId = src.slice(UPLOAD_PREFIX.length);
  const documents = resolution?.assignment?.index?.documents ?? [];
  return documents.find((document) => document.documentId === documentId) ?? null;
}

export function clipboardLinkProject(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function recordLinkMetadata(
  element: Element,
  { ref, address }: { ref: string | null; address: string | null },
  resolution: LinkAnswerCache,
): void {
  if (address) element.setAttribute(LINK_ADDRESS_ATTRIBUTE, address);
  const projectId = resolution.assignment?.projectId ?? null;
  if (ref && projectId) {
    element.setAttribute(LINK_REF_ATTRIBUTE, ref);
    element.setAttribute(LINK_PROJECT_ATTRIBUTE, projectId);
  }
}

function linkMetadata(stored: LinkKey, resolution: LinkAnswerCache) {
  const ref = clipboardLinkRef(stored.ref);
  return { ref, address: currentLinkAddress({ ref, href: stored.href }, resolution) };
}

function pictureMetadata(attrs: PMNode["attrs"], resolution: LinkAnswerCache) {
  const src = String(attrs.src ?? "");
  const uploadRef = clipboardUploadRef(src);
  if (uploadRef) {
    const upload = uploadDocument(uploadRef, resolution);
    return {
      ref: uploadRef,
      address: upload ? storedHref({ kind: "document", uri: upload.uri }, "") : null,
    };
  }
  const picture = pictureKeyOfNode(attrs);
  return picture ? linkMetadata(picture, resolution) : null;
}

function keepPastedRefs(html: string, projectId: string | null): string {
  if (!html.includes("data-meridian-")) return html;
  const container = document.createElement("template");
  container.innerHTML = html;
  for (const element of container.content.querySelectorAll(
    `[data-meridian-link], img[${LINK_ADDRESS_ATTRIBUTE}], img[${LINK_REF_ATTRIBUTE}]`,
  )) {
    const picture = element.localName === "img";
    const address = clipboardLinkAddress(element.getAttribute(LINK_ADDRESS_ATTRIBUTE));
    const recorded = element.getAttribute(LINK_REF_ATTRIBUTE);
    const ref = picture ? clipboardPictureRef(recorded) : clipboardLinkRef(recorded);
    const project = clipboardLinkProject(element.getAttribute(LINK_PROJECT_ATTRIBUTE));
    for (const attribute of [
      LINK_ADDRESS_ATTRIBUTE,
      LINK_REF_ATTRIBUTE,
      LINK_PROJECT_ATTRIBUTE,
      LINK_KEPT_REF_ATTRIBUTE,
    ])
      element.removeAttribute(attribute);
    const kept = ref && projectId && project === projectId ? ref : null;
    if (picture && kept?.startsWith(UPLOAD_PREFIX)) {
      element.setAttribute("src", kept);
      continue;
    }
    if (!address) {
      if (picture) (element.closest("figure[data-type='figure']") ?? element).remove();
      continue;
    }
    if (picture) element.setAttribute("src", address);
    else element.setAttribute("data-meridian-link", address);
    if (kept) element.setAttribute(LINK_KEPT_REF_ATTRIBUTE, kept);
  }
  return container.innerHTML;
}

export function clipboardLinkScope(state: EditorState): DocumentLinkScope {
  const resolution = linkClipboardPluginKey.getState(state) ?? null;
  return {
    spellLink: ({ href, ref }) => {
      const address = currentLinkAddress({ ref, href }, resolution);
      return {
        href: address ?? href,
        address: ref && address ? (resolveDocumentHref(address, null)?.uri ?? null) : null,
      };
    },
    spellSource: (attrs) => {
      const upload = uploadDocument(attrs.src, resolution);
      if (!upload && attrs.src.startsWith(UPLOAD_PREFIX)) return UNSPELLED_UPLOAD;
      const picture = pictureKeyOfNode(attrs);
      const entry = picture?.ref && resolution ? resolution.read(picture) : null;
      const known = upload ?? (entry?.state === "document" ? entry.document : null);
      const holder: LinkHolder = {
        uri: resolution?.baseUri ?? null,
        projectId: resolution?.assignment?.projectId ?? "",
        view: { kind: "live" },
      };
      return spellStoredLink(
        { ref: attrs.ref, href: attrs.src },
        holder,
        sourceResolution(known, entry?.state === "gone", attrs.ref, holder.projectId),
        "manuscript-root",
      );
    },
  };
}

function sourceResolution(
  document: LinkAssignmentDocument | null,
  gone: boolean,
  ref: string | null,
  projectId: string,
): LinkResolution {
  if (document) {
    const { documentId, uri } = document;
    return {
      kind: "document",
      document: {
        documentId,
        owner: { workId: null },
        projectId,
        uri,
        presence: "live",
        readable: true,
        nameable: true,
      },
      inDraft: false,
    };
  }
  if (gone) return { kind: "gone" };
  return ref === null ? { kind: "address" } : { kind: "unknown" };
}

export function linkClipboardPlugin(schema: Schema, resolution: LinkAnswerCache): Plugin {
  const base = DOMSerializer.fromSchema(schema);
  const renderLink = base.marks.link;
  const marks = renderLink
    ? {
        ...base.marks,
        link: (mark: Mark, inline: boolean) => {
          const rendered = DOMSerializer.renderSpec(document, renderLink(mark, inline));
          if (rendered.dom instanceof Element && rendered.dom.hasAttribute("data-meridian-link"))
            recordLinkMetadata(
              rendered.dom,
              linkMetadata(linkKeyOfMark(mark.attrs), resolution),
              resolution,
            );
          return rendered;
        },
      }
    : base.marks;
  const nodes = { ...base.nodes };
  for (const name of ["image", "figure"]) {
    const renderPicture = base.nodes[name];
    if (!renderPicture) continue;
    nodes[name] = (node: PMNode) => {
      const rendered = DOMSerializer.renderSpec(document, renderPicture(node));
      const picture = pictureMetadata(node.attrs, resolution);
      const image =
        rendered.dom instanceof Element
          ? rendered.dom.localName === "img"
            ? rendered.dom
            : rendered.dom.querySelector("img")
          : null;
      if (picture && image) recordLinkMetadata(image, picture, resolution);
      return rendered;
    };
  }
  return new Plugin<LinkAnswerCache>({
    key: linkClipboardPluginKey,
    state: { init: () => resolution, apply: (_transaction, value) => value },
    props: {
      clipboardSerializer: new NestingDOMSerializer(nodes, marks),
      transformPastedHTML: (html) => keepPastedRefs(html, resolution.assignment?.projectId ?? null),
      transformPasted: (slice, view) =>
        view.dragging
          ? slice
          : assignPastedSlice(
              slice,
              resolution.assignment ?? { holderUri: null, projectId: null, index: null },
            ),
    },
  });
}
