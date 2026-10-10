/**
 * How an internal link keeps naming the same document when it travels on the
 * clipboard.
 *
 * Copying records, on every internal link in the clipboard HTML, what it
 * names beside the href as stored (`data-meridian-link`):
 *
 * - `data-meridian-address`: where it points now, as a full Context URI with
 *   any fragment or query. A link whose document has moved records the
 *   document's current address, never the stale one it was written with;
 * - `data-meridian-ref` and `data-meridian-project`: the stored ref and the
 *   project it names a document in, for a link that carries one.
 *
 * Pasting into an Editor keeps the ref only when the copy came from the same
 * project; the link is then `{ ref, href: address }`. Anything else (another
 * project, a link with no metadata, Markdown text) is assigned fresh from its
 * address by the editor's one paste door (`transformPasted`, through
 * `link-assignment.ts`), exactly as if the writer had typed it. The metadata is
 * never a capability: a kept `doc:` ref still resolves through the reader's
 * own catalog and draws gone when they cannot read it.
 *
 * An `image` or `figure` with a ref travels the same way, its metadata on the
 * picture's `<img>`: the sanitizer lets a recorded address through as the
 * source, a same-project paste keeps the ref, and anything else arrives with
 * no ref and is assigned its address fresh. An `asset:<id>` upload is the
 * same thing stored differently: it records `asset:<id>` as its ref, and the
 * address the project catalog holds that id at now when it holds it. A
 * same-project paste restores the `asset:` source from that recorded identity
 * alone, so a just-uploaded picture copies before the catalog knows it;
 * another project binds the recorded address, and drops the whole picture
 * (a figure with its caption) when none was recorded.
 *
 * The text/plain flavour spells every internal link as its full address, so
 * it means the same thing in another app or through the Markdown paste door;
 * a picture's source is spelled from the same answer, under its own grammar.
 * The chat composer reads the recorded address (chat has no folder).
 */

import {
  type LinkHolder,
  type LinkResolution,
  parseLinkRef,
  qualifyContextUriByHolder,
  resolveDocumentHref,
  spellStoredLink,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import type { DocumentLinkScope } from "@meridian/markup";
import { UNSPELLED_UPLOAD } from "@meridian/markup/links";
import { DOMSerializer, type Mark, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

import { assignPastedSlice, type LinkAssignmentDocument } from "./link-assignment";
import {
  type LinkAnswerCache,
  type LinkKey,
  linkKeyOfMark,
  pictureKeyOfNode,
} from "./link-resolution";
import { classifyLinkTarget } from "./link-target";

export const LINK_ADDRESS_ATTRIBUTE = "data-meridian-address";
export const LINK_REF_ATTRIBUTE = "data-meridian-ref";
export const LINK_PROJECT_ATTRIBUTE = "data-meridian-project";
/**
 * What the paste transform leaves for the link mark's parser: a ref it chose
 * to keep. Never copied and never allowed through the paste sanitizer, so
 * clipboard HTML cannot set it.
 */
export const LINK_KEPT_REF_ATTRIBUTE = "data-meridian-kept-ref";

const linkClipboardPluginKey = new PluginKey<LinkAnswerCache>("meridianLinkClipboard");

/**
 * The full address an internal href names from its holder, spelled as an href
 * (`%`, `#` and `?` in a filename encoded) with its fragment or query, or null
 * for an external link or one that cannot be resolved (a relative path with no
 * holder). Contextual owned links carry the holder's authority when copied;
 * lineage Scratch keeps its chat handle while Uploads keep No Work ownership.
 */
function linkHrefAddress(href: string, holderUri: string | null): string | null {
  const target = classifyLinkTarget(href);
  if (!target || target.kind === "external") return null;
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : resolveDocumentHref(target.path, holderUri);
  if (!resolved) return null;
  return storedHref(qualifyContextUriByHolder(resolved.uri, holderUri), resolved.suffix);
}

/**
 * Where a stored link points now, as a full address: the document its ref
 * resolved to, at that document's current address, else the address its href
 * names. Null for an external or unresolvable link.
 */
function currentLinkAddress(link: LinkKey, resolution: LinkAnswerCache | null): string | null {
  const entry = link.ref && resolution ? resolution.read(link) : null;
  if (entry?.state === "document")
    return storedHref(entry.document.uri, splitDocumentHrefSuffix(link.href).suffix);
  return linkHrefAddress(link.href, resolution?.baseUri ?? null);
}

/**
 * A recorded address read back from untrusted clipboard HTML, or null: only a
 * full address in exactly the spelling `linkHrefAddress` writes.
 */
export function clipboardLinkAddress(value: string | null): string | null {
  if (!value) return null;
  const resolved = resolveDocumentHref(value, null);
  return resolved && storedHref(resolved.uri, resolved.suffix) === value ? value : null;
}

/** A recorded ref read back from untrusted clipboard HTML, or null. */
export function clipboardLinkRef(value: string | null): string | null {
  return value && parseLinkRef(value) ? value : null;
}

const UPLOAD_PREFIX = "asset:";

/**
 * A recorded upload ref read back from untrusted clipboard HTML, or null: an
 * `asset:<id>` with an id a `doc:` ref could name.
 */
export function clipboardUploadRef(value: string | null): string | null {
  if (!value?.startsWith(UPLOAD_PREFIX)) return null;
  return parseLinkRef(`doc:${value.slice(UPLOAD_PREFIX.length)}`)?.kind === "doc" ? value : null;
}

/** A recorded picture ref read back from untrusted clipboard HTML, or null. */
export function clipboardPictureRef(value: string | null): string | null {
  return value?.startsWith(UPLOAD_PREFIX) ? clipboardUploadRef(value) : clipboardLinkRef(value);
}

/** The catalog's document an `asset:<id>` upload source names, or null. */
function uploadDocument(
  src: string,
  resolution: LinkAnswerCache | null,
): LinkAssignmentDocument | null {
  if (!src.startsWith(UPLOAD_PREFIX)) return null;
  const documentId = src.slice(UPLOAD_PREFIX.length);
  const documents = resolution?.assignment?.index?.documents ?? [];
  return documents.find((document) => document.documentId === documentId) ?? null;
}

/** A recorded project id read back from untrusted clipboard HTML, or null. */
export function clipboardLinkProject(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** Copy, HTML flavour: what one rendered link mark or picture names, beside its href. */
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

/** What a stored link (or ref-bearing picture) records: its ref and current address. */
function linkMetadata(stored: LinkKey, resolution: LinkAnswerCache) {
  const ref = clipboardLinkRef(stored.ref);
  return { ref, address: currentLinkAddress({ ref, href: stored.href }, resolution) };
}

/**
 * What a picture records, or null for one that names nothing the project
 * holds. An upload always records its identity; its address only once the
 * catalog holds it.
 */
function pictureMetadata(attrs: PMNode["attrs"], resolution: LinkAnswerCache) {
  const src = String(attrs.src ?? "");
  const uploadRef = clipboardUploadRef(src);
  if (uploadRef) {
    const upload = uploadDocument(uploadRef, resolution);
    return { ref: uploadRef, address: upload ? storedHref(upload.uri, "") : null };
  }
  const picture = pictureKeyOfNode(attrs);
  return picture ? linkMetadata(picture, resolution) : null;
}

/**
 * Paste into an Editor: a same-project link or picture keeps its ref at its
 * recorded address (an upload its `asset:` source); every other recorded one
 * pastes its address with no ref, for the paste door to assign fresh.
 */
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
      // An upload copied before its catalog entry carries no address: outside
      // its project there is nothing to bind, so the picture is not pasted. A
      // figure is one picture; left behind, its shell parses as an empty figure.
      if (picture) (element.closest("figure[data-type='figure']") ?? element).remove();
      continue;
    }
    if (picture) element.setAttribute("src", address);
    else element.setAttribute("data-meridian-link", address);
    if (kept) element.setAttribute(LINK_KEPT_REF_ATTRIBUTE, kept);
  }
  return container.innerHTML;
}

/**
 * Copy, text/plain flavour: the Markdown codec's link scope for this editor.
 * Every internal link is spelled as its full current address (a resolved ref
 * at its document's address now, otherwise the address its href names), so
 * the text means the same thing wherever it lands, holder or not. A picture
 * whose ref answers a document, or an upload the catalog holds, is spelled at
 * that document's current address under the manuscript-root grammar, as rich
 * copy records it; an upload the catalog does not hold has no source, since
 * its id is never text; any other source (gone, missing, ref-less) as stored.
 */
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

/**
 * What is known of a picture's document, as the speller reads it. Anything not
 * yet answered spells as stored, as it does with no tree loaded.
 */
function sourceResolution(
  document: LinkAssignmentDocument | null,
  gone: boolean,
  ref: string | null,
  projectId: string,
): LinkResolution {
  if (document) {
    const { documentId, uri } = document;
    // The speller reads only `document.uri`; the answer carries no presence,
    // so the other fields are neutral fillers, not facts about the document.
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

/**
 * The plugin that owns both directions on an Editor: the clipboard serializer
 * that records what each link and picture names, the HTML transform that keeps
 * a same-project ref, and the paste transform that assigns every link and
 * picture source still without one. Its state is the editor's resolution, whose assignment scope is the
 * holder's address, project and local index. Its HTML transform runs after
 * the paste sanitizer, which keeps well-formed metadata only.
 */
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
      clipboardSerializer: new DOMSerializer(nodes, marks),
      transformPastedHTML: (html) => keepPastedRefs(html, resolution.assignment?.projectId ?? null),
      transformPasted: (slice, view) =>
        // A drag inside the editor moves links it already holds, as stored.
        view.dragging
          ? slice
          : assignPastedSlice(
              slice,
              resolution.assignment ?? { holderUri: null, projectId: null, index: null },
            ),
    },
  });
}
