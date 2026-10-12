/** Export-only spelling: identities, settlements and addresses use the frozen inventory. */
import { posix } from "node:path";
import {
  parseContextUri,
  parseLinkRef,
  resolveDocumentHref,
  type SpelledHref,
  splitDocumentHrefSuffix,
} from "@meridian/contracts";
import { parseDocumentFilename } from "@meridian/contracts/protocol";
import type { DocumentLinkScope } from "@meridian/markup";
import type { HolderLinkScope } from "@meridian/markup/links";

export class ExportLinkScope implements DocumentLinkScope {
  constructor(
    private readonly holderId: string,
    private readonly links: HolderLinkScope,
    private readonly paths: ReadonlyMap<string, string>,
    private readonly uris: ReadonlyMap<string, string>,
    private readonly addresses: ReadonlyMap<string, string>,
    private readonly roots: ReadonlyMap<string, string>,
    private readonly settlements: ReadonlyMap<string, string>,
    private readonly onExcluded: () => void,
  ) {}

  private spell(
    target: string | undefined,
    suffix: string,
    fallback: SpelledHref,
    internal: boolean,
  ): SpelledHref {
    const holder = this.paths.get(this.holderId);
    if (!target || !holder) {
      if (internal) this.onExcluded();
      return fallback;
    }
    const path = posix
      .relative(posix.dirname(holder), target)
      .split("/")
      .map((segment) =>
        encodeURIComponent(segment).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join("/");
    return { href: path + suffix, address: fallback.address };
  }

  spellLink(attrs: { href: string; ref: string | null }): SpelledHref {
    const address = resolveDocumentHref(attrs.href, this.uris.get(this.holderId) ?? null);
    const ref = attrs.ref ? parseLinkRef(attrs.ref) : null;
    const id =
      ref?.kind === "doc"
        ? ref.documentId
        : ref?.kind === "ahead"
          ? this.settlements.get(ref.aheadId)
          : undefined;
    const fallback = {
      href: attrs.href,
      address: id ? (this.uris.get(id) ?? address?.uri ?? null) : (address?.uri ?? null),
    };
    let target = id
      ? this.paths.get(id)
      : !attrs.ref && address
        ? this.addresses.get(address.uri)
        : undefined;
    if (ref?.kind === "ahead" && !id && address)
      target = this.addresses.get(address.uri) ?? this.aheadPath(address.uri);
    return this.spell(
      target,
      address?.suffix ?? splitDocumentHrefSuffix(attrs.href).suffix,
      fallback,
      !!attrs.ref || !!address,
    );
  }

  spellSource(attrs: { src: string; ref: string | null }): SpelledHref {
    if (attrs.src.startsWith("asset:")) {
      const id = attrs.src.slice(6);
      const uri = this.uris.get(id);
      return this.spell(
        this.paths.get(id),
        "",
        uri ? { href: uri, address: uri } : this.links.spellSource(attrs),
        true,
      );
    }
    if (attrs.ref) return this.spellLink({ href: attrs.src, ref: attrs.ref });
    // Bare image sources follow the ordinary manuscript-root grammar, not the holder folder.
    const address = resolveDocumentHref(attrs.src, "manuscript://_");
    return this.spell(
      address ? this.addresses.get(address.uri) : undefined,
      address?.suffix ?? "",
      { href: attrs.src, address: address?.uri ?? null },
      !!address,
    );
  }
  private aheadPath(uri: string): string | undefined {
    const parsed = parseContextUri(uri);
    if (!parsed.ok) return undefined;
    const path = parsed.value.path.split("/");
    const filename = parseDocumentFilename(path.pop() ?? "");
    if (!filename.ok) return undefined;
    const root = uri.slice(0, -parsed.value.path.length);
    let prefix = this.roots.get(root)?.split("/");
    let matched = prefix ? 0 : -1;
    for (const [address, exported] of this.addresses) {
      if (!address.startsWith(root)) continue;
      const folders = address.slice(root.length).split("/").slice(0, -1);
      let common = 0;
      while (common < folders.length && common < path.length && folders[common] === path[common])
        common++;
      if (common <= matched) continue;
      const parts = exported.split("/");
      prefix = parts.slice(0, parts.length - folders.length - 1 + common);
      matched = common;
    }
    if (!prefix) {
      const area = { manuscript: "Manuscript", kb: "Knowledge Base", unfiled: "Unfiled" }[
        parsed.value.scheme as "kb"
      ];
      if (!area) return undefined;
      prefix = [area];
      matched = 0;
    }
    const { name, extension, filetype } = filename.value;
    return [
      ...prefix,
      ...path.slice(matched),
      `${name}.${filetype === "markdown" ? "md" : extension}`,
    ].join("/");
  }
}
