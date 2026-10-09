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
 * project, a link with no metadata, Markdown text) is bound fresh from its
 * address by the editor's one paste door (`transformPasted`, through
 * `link-binding.ts`), exactly as if the writer had typed it. The metadata is
 * never a capability: a kept `doc:` ref still resolves through the reader's
 * own catalog and draws gone when they cannot read it.
 *
 * The text/plain flavour spells every internal link as its full address, so
 * it means the same thing in another app or through the Markdown paste door.
 * The chat composer reads the recorded address (chat has no folder).
 */

import {
  parseContextUri,
  parseLinkRef,
  resolveDocumentHref,
  splitDocumentHrefSuffix,
  storedHref,
} from "@meridian/contracts";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { type DocumentLinkScope, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { DOMSerializer, type Mark, type Schema } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

import { bindPastedSlice } from "./link-binding";
import { type LinkAnswerCache, type LinkKey, linkKeyOfMark } from "./link-resolution";
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

/** A recorded project id read back from untrusted clipboard HTML, or null. */
export function clipboardLinkProject(value: string | null): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

/** Copy, HTML flavour: what one rendered link mark names, beside its href. */
function recordLinkMetadata(element: Element, mark: Mark, resolution: LinkAnswerCache): void {
  const stored = linkKeyOfMark(mark.attrs);
  const href = stored.href;
  const ref = clipboardLinkRef(stored.ref);
  const address = currentLinkAddress({ ref, href }, resolution);
  if (address) element.setAttribute(LINK_ADDRESS_ATTRIBUTE, address);
  const projectId = resolution.binding?.projectId ?? null;
  if (ref && projectId) {
    element.setAttribute(LINK_REF_ATTRIBUTE, ref);
    element.setAttribute(LINK_PROJECT_ATTRIBUTE, projectId);
  }
}

/**
 * Paste into an Editor: a same-project link keeps its ref at its recorded
 * address; every other recorded link pastes its address unbound, for the
 * paste door to bind fresh.
 */
function keepPastedRefs(html: string, projectId: string | null): string {
  if (!html.includes("data-meridian-")) return html;
  const container = document.createElement("template");
  container.innerHTML = html;
  for (const element of container.content.querySelectorAll("[data-meridian-link]")) {
    const address = clipboardLinkAddress(element.getAttribute(LINK_ADDRESS_ATTRIBUTE));
    const ref = clipboardLinkRef(element.getAttribute(LINK_REF_ATTRIBUTE));
    const project = clipboardLinkProject(element.getAttribute(LINK_PROJECT_ATTRIBUTE));
    for (const attribute of [
      LINK_ADDRESS_ATTRIBUTE,
      LINK_REF_ATTRIBUTE,
      LINK_PROJECT_ATTRIBUTE,
      LINK_KEPT_REF_ATTRIBUTE,
    ])
      element.removeAttribute(attribute);
    if (!address) continue;
    element.setAttribute("data-meridian-link", address);
    if (ref && projectId && project === projectId)
      element.setAttribute(LINK_KEPT_REF_ATTRIBUTE, ref);
  }
  return container.innerHTML;
}

/**
 * Copy, text/plain flavour: the Markdown codec's link scope for this editor.
 * Every internal link is spelled as its full current address (a resolved ref
 * at its document's address now, otherwise the address its href names), so
 * the text means the same thing wherever it lands, holder or not.
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
    spellSource: UNSCOPED_DOCUMENT_LINKS.spellSource,
  };
}

/**
 * The plugin that owns both directions on an Editor: the clipboard serializer
 * that records what each link names, the HTML transform that keeps a
 * same-project ref, and the paste transform that binds every link still
 * unbound. Its state is the editor's resolution, whose binding scope is the
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
            recordLinkMetadata(rendered.dom, mark, resolution);
          return rendered;
        },
      }
    : base.marks;
  return new Plugin<LinkAnswerCache>({
    key: linkClipboardPluginKey,
    state: { init: () => resolution, apply: (_transaction, value) => value },
    props: {
      clipboardSerializer: new DOMSerializer(base.nodes, marks),
      transformPastedHTML: (html) => keepPastedRefs(html, resolution.binding?.projectId ?? null),
      transformPasted: (slice, view) =>
        // A drag inside the editor moves links it already holds, as stored.
        view.dragging
          ? slice
          : bindPastedSlice(
              slice,
              resolution.binding ?? { holderUri: null, projectId: null, index: null },
            ),
    },
  });
}
