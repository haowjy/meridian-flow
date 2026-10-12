/**
 * The address a chat door's document is filed under in its catalog: the resolved
 * owner's handle spelled out (`scratch://@/c2/x`, `scratch://@arc-one/x`,
 * `uploads://@/x`), whatever shorthand the door was written with. A bare
 * `scratch://x` in a chat means that chat's lineage or its Work, and the catalog
 * only knows the explicit spelling. Null when the owner's handle is not known yet.
 */
import { parseContextUri } from "@meridian/contracts/context-uri";
import { isWorkScopedProjectContextScheme } from "@meridian/contracts/protocol";
import { resourceContextAuthority, resourceUriQualifier } from "@meridian/resource-replica";

export function canonicalDoorUri(
  target: {
    scheme: Parameters<typeof resourceContextAuthority>[0];
    path: string;
    workId: string | null;
    rootThreadId?: string;
  },
  handles: {
    /** The first chat's handle, for a chat's Scratch. */
    ownerRef?: string | null;
    /** The Work's slug: null for No Work, undefined while unknown. */
    workSlug?: string | null;
  },
): string | null {
  if (!isWorkScopedProjectContextScheme(target.scheme))
    return `${target.scheme}://${target.path.replace(/^\/+/, "")}`;
  try {
    const authority = resourceContextAuthority(target.scheme, {
      workId: target.rootThreadId ? null : target.workId,
      workSlug: handles.workSlug,
      rootThreadId: target.rootThreadId,
      rootThreadRef: handles.ownerRef,
    });
    const parsed = parseContextUri(
      `${target.scheme}://${resourceUriQualifier(authority)}${target.path.replace(/^\/+/, "")}`,
    );
    return parsed.ok ? parsed.value.normalized : null;
  } catch {
    return null;
  }
}
