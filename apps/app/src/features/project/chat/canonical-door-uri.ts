/**
 * The address a chat door's document is filed under in its tree: the resolved
 * owner's handle spelled out (`scratch://@c2/x`, `scratch://@w3/x`,
 * `uploads://@c15/x`), whatever shorthand the door was written with. A bare
 * `scratch://x` in a chat means that chat's lineage or its Work, and the tree
 * only knows the explicit spelling. Null when the owner's handle is not known yet.
 */
import {
  canonicalContextUri,
  formatParsedContextUri,
  isOwnedContextScheme,
  type ParsedContextAuthority,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";

/** What an owned scheme's address spells for its owner, or null while a handle is unknown. */
function doorAuthority(
  target: { scheme: ProjectContextTreeScheme; rootThreadId?: string; chatId?: string },
  handles: { ownerRef?: string | null; workHandle?: string | null },
): ParsedContextAuthority | null {
  if (target.scheme === "uploads") {
    if (!target.chatId) return null;
    // A chat that does not exist yet has no handle, so its uploads take the contextual form.
    return handles.ownerRef ? { kind: "chat", chatRef: handles.ownerRef } : { kind: "contextual" };
  }
  if (target.chatId) return null;
  if (target.rootThreadId)
    return handles.ownerRef ? { kind: "lineage", rootThreadRef: handles.ownerRef } : null;
  const workHandle = handles.workHandle ? decodeWorkHandle(handles.workHandle) : null;
  return workHandle ? { kind: "work", workHandle } : null;
}

export function canonicalDoorUri(
  target: {
    scheme: ProjectContextTreeScheme;
    path: string;
    workId: string | null;
    rootThreadId?: string;
    /** The chat that owns an upload. */
    chatId?: string;
  },
  handles: {
    /** The owner's handle: the first chat's for its Scratch, the chat's for its uploads. */
    ownerRef?: string | null;
    /** The Work's handle: null for No Work, undefined while unknown. */
    workHandle?: string | null;
  },
): string | null {
  if (!isOwnedContextScheme(target.scheme)) return canonicalContextUri(target.scheme, target.path);
  const authority = doorAuthority(target, handles);
  if (!authority) return null;
  try {
    const uri = formatParsedContextUri(target.scheme, target.path.replace(/^\/+/, ""), authority);
    const parsed = parseContextUri(uri);
    return parsed.ok ? parsed.value.normalized : null;
  } catch {
    return null;
  }
}
