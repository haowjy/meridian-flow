/** Derive address-index rows without resolving whether their target exists. */

import { documentAddressKey, resolveDocumentHref } from "@meridian/contracts";
import { isProjectScopedScheme, parseContextUri } from "@meridian/contracts/context-uri";
import type { ProjectId } from "@meridian/contracts/runtime";

export type DocumentLinkRow = {
  href: string;
  targetProjectId: ProjectId | null;
  targetKey: string | null;
  occurrences: number;
};

export function deriveDocumentLinkRows(input: {
  occurrences: readonly { href: string }[];
  holderUri: string;
  holderProjectId: ProjectId;
  personalProjectId: ProjectId | null;
}): DocumentLinkRow[] {
  const holder = parseContextUri(input.holderUri);
  if (!holder.ok) throw new RangeError(`Invalid holder URI: ${input.holderUri}`);
  const rows = new Map<string, DocumentLinkRow>();
  for (const { href } of input.occurrences) {
    const existing = rows.get(href);
    if (existing) {
      existing.occurrences++;
      continue;
    }
    const resolved = resolveDocumentHref(href, input.holderUri);
    if (!resolved) continue;
    const target = parseContextUri(resolved.uri);
    if (!target.ok) continue;
    const { scheme, authority } = target.value;
    const contextual = !isProjectScopedScheme(scheme)
      ? authority.kind === "contextual"
      : holder.value.scheme === "user" && scheme !== "user";
    const targetProjectId = contextual
      ? null
      : scheme === "user"
        ? input.personalProjectId
        : input.holderProjectId;
    if (!contextual && !targetProjectId)
      throw new Error("A user link requires the holder owner's personal project");
    rows.set(href, {
      href,
      targetProjectId,
      targetKey: contextual ? null : documentAddressKey(resolved.uri),
      occurrences: 1,
    });
  }
  return [...rows.values()];
}
