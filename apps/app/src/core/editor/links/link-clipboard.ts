/**
 * How an internal link keeps naming the same document when it travels on the
 * clipboard.
 *
 * A relative link means something only beside the document holding it:
 * `../volume-2/chapter-1.md` pasted into `notes/plan.md` would point somewhere
 * else. So copying records, for every internal link in the clipboard HTML, the
 * address it resolves to (`data-meridian-address`, the canonical Context URI
 * with any fragment or query) beside the href as written
 * (`data-meridian-link`). Each paste target spells that address for itself:
 *
 * - an Editor re-spells it for its own holder (`spellDocumentHref`): relative
 *   within the holder's area, the full URI across areas or from a document
 *   with no address yet;
 * - the chat composer takes the full Context URI (chat has no folder);
 * - the text/plain flavour carries full addresses, so it means the same thing
 *   in another app or through the Markdown paste door.
 *
 * A link with no recorded address (pasted from outside the app) keeps its href.
 * Nothing here enters the schema or the stored Markdown: the address lives only
 * on the clipboard.
 */

import { parseContextUri, resolveDocumentHref, spellDocumentHref } from "@meridian/contracts";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { DOMSerializer, Fragment, type Node as PMNode, type Schema, Slice } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";

import type { LinkResolution } from "./link-resolution";
import { classifyLinkTarget } from "./link-target";

export const LINK_ADDRESS_ATTRIBUTE = "data-meridian-address";

const linkClipboardPluginKey = new PluginKey<LinkResolution>("meridianLinkClipboard");

/**
 * The full address an internal href names from its holder, spelled as an href
 * (`%`, `#` and `?` in a filename encoded) with its fragment or query, or null
 * for an external link or one that cannot be resolved (a relative path with no
 * holder). A contextual `scratch://` or `uploads://` link in a Work's own
 * Scratch means that Work, so it is recorded with the holder's authority and
 * keeps meaning that Work wherever it is pasted.
 */
export function linkHrefAddress(href: string, holderUri: string | null): string | null {
  const target = classifyLinkTarget(href);
  if (!target || target.kind === "external") return null;
  const resolved =
    target.kind === "scheme"
      ? resolveDocumentHref(target.uri, null)
      : resolveDocumentHref(target.path, holderUri);
  if (!resolved) return null;
  return spellDocumentHref(null, qualifiedByHolder(resolved.uri, holderUri)) + resolved.suffix;
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
 * A recorded address read back from untrusted clipboard HTML, or null: only a
 * full address in exactly the spelling `linkHrefAddress` writes.
 */
export function clipboardLinkAddress(value: string | null): string | null {
  if (!value) return null;
  const resolved = resolveDocumentHref(value, null);
  return resolved && spellDocumentHref(null, resolved.uri) + resolved.suffix === value
    ? value
    : null;
}

/** An address spelled for the document it lands in. */
export function spellLinkAddress(address: string, holderUri: string | null): string | null {
  const resolved = resolveDocumentHref(address, null);
  return resolved ? spellDocumentHref(holderUri, resolved.uri) + resolved.suffix : null;
}

/** Copy, HTML flavour: record each internal link's address beside its href. */
export function recordLinkAddresses(root: ParentNode, holderUri: string | null): void {
  for (const element of root.querySelectorAll("[data-meridian-link]")) {
    const address = linkHrefAddress(element.getAttribute("data-meridian-link") ?? "", holderUri);
    if (address) element.setAttribute(LINK_ADDRESS_ATTRIBUTE, address);
  }
}

/** Paste into an Editor: spell every recorded address for this holder. */
export function respellPastedLinks(html: string, holderUri: string | null): string {
  if (!html.includes(LINK_ADDRESS_ATTRIBUTE)) return html;
  const container = document.createElement("template");
  container.innerHTML = html;
  for (const element of container.content.querySelectorAll(`[${LINK_ADDRESS_ATTRIBUTE}]`)) {
    const address = clipboardLinkAddress(element.getAttribute(LINK_ADDRESS_ATTRIBUTE));
    const href = address ? spellLinkAddress(address, holderUri) : null;
    if (href && element.hasAttribute("data-meridian-link"))
      element.setAttribute("data-meridian-link", href);
    element.removeAttribute(LINK_ADDRESS_ATTRIBUTE);
  }
  return container.innerHTML;
}

/** Copy, text/plain flavour: every internal link spelled as its full address. */
export function linksAsAddresses(slice: Slice, state: EditorState): Slice {
  const holderUri = linkClipboardPluginKey.getState(state)?.baseUri ?? null;
  const addressed = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = [];
    fragment.forEach((node) => {
      if (!node.isText) {
        nodes.push(node.copy(addressed(node.content)));
        return;
      }
      const link = node.marks.find((mark) => mark.type.name === "link");
      const address = link ? linkHrefAddress(String(link.attrs.href ?? ""), holderUri) : null;
      nodes.push(
        link && address
          ? node.mark(
              node.marks.map((mark) =>
                mark === link ? mark.type.create({ ...mark.attrs, href: address }) : mark,
              ),
            )
          : node,
      );
    });
    return Fragment.from(nodes);
  };
  return new Slice(addressed(slice.content), slice.openStart, slice.openEnd);
}

/**
 * The plugin that owns both directions on an Editor: the clipboard serializer
 * that records addresses, and the paste transform that re-spells them. Its
 * state is the editor's resolution, whose `baseUri` is the holder's address.
 * It runs after the paste sanitizer, which keeps a well-formed address.
 */
export function linkClipboardPlugin(schema: Schema, resolution: LinkResolution): Plugin {
  const base = DOMSerializer.fromSchema(schema);
  class AddressRecordingSerializer extends DOMSerializer {
    override serializeFragment(
      ...args: Parameters<DOMSerializer["serializeFragment"]>
    ): ReturnType<DOMSerializer["serializeFragment"]> {
      const out = super.serializeFragment(...args);
      recordLinkAddresses(out, resolution.baseUri);
      return out;
    }
  }
  return new Plugin<LinkResolution>({
    key: linkClipboardPluginKey,
    state: { init: () => resolution, apply: (_transaction, value) => value },
    props: {
      clipboardSerializer: new AddressRecordingSerializer(base.nodes, base.marks),
      transformPastedHTML: (html) => respellPastedLinks(html, resolution.baseUri),
    },
  });
}
