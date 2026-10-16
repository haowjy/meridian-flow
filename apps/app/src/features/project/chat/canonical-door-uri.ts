/**
 * The address a chat door's document is filed under in its catalog: the resolved
 * owner's handle spelled out (`scratch://@/c2/x`, `scratch://@arc-one/x`,
 * `uploads://@/c15/x`), whatever shorthand the door was written with. A bare
 * `scratch://x` in a chat means that chat's lineage or its Work, and the catalog
 * only knows the explicit spelling. Null when the owner's handle is not known yet.
 */
import { isOwnedContextScheme, parseContextUri } from "@meridian/contracts/context-uri";
import { resourceContextAuthority, resourceContextUri } from "@meridian/resource-replica";

export function canonicalDoorUri(
  target: {
    scheme: Parameters<typeof resourceContextAuthority>[0];
    path: string;
    workId: string | null;
    rootThreadId?: string;
    /** The chat that owns an upload. */
    chatId?: string;
  },
  handles: {
    /** The owner's handle: the first chat's for its Scratch, the chat's for its uploads. */
    ownerRef?: string | null;
    /** The Work's slug: null for No Work, undefined while unknown. */
    workSlug?: string | null;
  },
): string | null {
  if (!isOwnedContextScheme(target.scheme))
    return `${target.scheme}://${target.path.replace(/^\/+/, "")}`;
  try {
    const authority = resourceContextAuthority(target.scheme, {
      workId: target.rootThreadId || target.chatId ? null : target.workId,
      workSlug: handles.workSlug,
      rootThreadId: target.rootThreadId,
      rootThreadRef: handles.ownerRef,
      chatId: target.chatId,
      chatRef: handles.ownerRef,
    });
    const uri = resourceContextUri(target.scheme, target.path, authority);
    const parsed = uri ? parseContextUri(uri) : null;
    return parsed?.ok ? parsed.value.normalized : null;
  } catch {
    return null;
  }
}
