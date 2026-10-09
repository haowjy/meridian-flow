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
 * same thing stored differently: it records `asset:<id>` as its ref at the
 * address the project catalog holds that id at now, and a same-project paste
 * restores the `asset:` source. An upload the catalog does not hold yet
 * records nothing.
 *
 * The text/plain flavour spells every internal link as its full address, so
 * it means the same thing in another app or through the Markdown paste door;
 * a picture's source is spelled from the same answer, under its own grammar.
 * The chat composer reads the recorded address (chat has no folder).
 */

import {
  type LinkHolder,
  type LinkResolution,
  parseContextUri,
  parseLinkRef,
  resolveDocumentHref,
  spellStoredLink,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import type { DocumentLinkScope } from "@meridian/markup";
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
 * holder). A contextual `scratch://` or `uploads://` link in a Work's own
 * Scratch means that Work, so it is recorded with the holder's authority and
 * keeps meaning that Work wherever it is pasted.
 */
function linkHrefAddress(href: string, holderUri: string | null): string | null {
  const target = classifyLinkTarget(href);
  if (!target || target.kind === "external") return null;
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : resolveDocumentHref(target.path, holderUri);
  if (!resolved) return null;
  return storedHref(qualifiedByHolder(resolved.uri, holderUri), resolved.suffix);
}

function qualifiedByHolder(uri: string, holderUri: string | null): string {
  const parsed = parseContextUri(uri);
  const holder = holderUri ? parseContextUri(holderUri) : null;
  if (!parsed.ok || parsed.value.authority.kind !== "contextual" || !holder?.ok) return uri;
  const { authority } = holder.value;
  if (!isWorkScopedProjectContextScheme(holder.value.scheme) || authority.kind === "contextual")
    return uri;
  if (!isWorkScopedProjectContextScheme(parsed.value.scheme)) return uri;
  const qualifier = authority.kind === "work" ? `@${authority.workSlug}` : "@";
  return `${parsed.value.scheme}://${qualifier}/${parsed.value.path}`;
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
 * A recorded picture ref read back from untrusted clipboard HTML, or null: a
 * link ref, or an upload's `asset:<id>` with an id a `doc:` ref could name.
 */
export function clipboardPictureRef(value: string | null): string | null {
  if (!value?.startsWith(UPLOAD_PREFIX)) return clipboardLinkRef(value);
  return parseLinkRef(`doc:${value.slice(UPLOAD_PREFIX.length)}`)?.kind === "doc" ? value : null;
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

/** What a picture records, or null for one that names nothing the project holds. */
function pictureMetadata(attrs: PMNode["attrs"], resolution: LinkAnswerCache) {
  const src = String(attrs.src ?? "");
  const upload = uploadDocument(src, resolution);
  if (upload) return { ref: src, address: storedHref(upload.uri, "") };
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
    `[data-meridian-link], img[${LINK_ADDRESS_ATTRIBUTE}]`,
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
    if (!address) continue;
    if (picture) element.setAttribute("src", address);
    else element.setAttribute("data-meridian-link", address);
    if (!ref || !projectId || project !== projectId) continue;
    if (ref.startsWith(UPLOAD_PREFIX)) element.setAttribute("src", ref);
    else element.setAttribute(LINK_KEPT_REF_ATTRIBUTE, ref);
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
 * copy records it; any other source (gone, missing, ref-less) as stored.
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
      const picture = pictureKeyOfNode(attrs);
      const entry = picture?.ref && resolution ? resolution.read(picture) : null;
      const known =
        uploadDocument(attrs.src, resolution) ??
        (entry?.state === "document" ? entry.document : null);
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
      document: { documentId, projectId, uri, presence: "live", readable: true, nameable: true },
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
