import {
  canonicalContextUri,
  formatParsedContextUri,
  isOwnedContextScheme,
  type ParsedContextAuthority,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { decodeWorkHandle } from "@meridian/contracts/works";

function doorAuthority(
  target: { rootThreadId?: string },
  handles: { ownerRef?: string | null; workHandle?: string | null },
): ParsedContextAuthority | null {
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
  },
  handles: {
    ownerRef?: string | null;
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
