/**
 * The two receipt lines an address can earn: a handle that is also a live Work's name, and a
 * dropped sigil. Neither is an error (the address resolved and the write is the model's own),
 * so the result says what the address reached and where the other reading lives, and undo
 * recovers. Both need a resolved owner, so both read the one owner lookup.
 */
import { formatParsedContextUri, parseUnifiedContextUri } from "@meridian/contracts/context-uri";
import { classifyHandleToken } from "@meridian/contracts/handles";
import type { OwnerLookup } from "../../domains/context/index.js";

function workAddress(handle: string): string {
  return formatParsedContextUri("scratch", "", {
    kind: "work",
    workHandle: handle as never,
  });
}

/** The line to put first in a read or write result, or null when the address means what it says. */
export async function ownerNotice(
  owners: OwnerLookup,
  projectId: string,
  requestedPath: string,
  canonicalUri: string,
): Promise<string | null> {
  const requested = parseUnifiedContextUri(requestedPath.replace(/#.*$/, ""));
  if (!requested.ok || requested.value.scheme !== "scratch") return null;
  const { authority, path } = requested.value;

  if (authority.kind === "work" || authority.kind === "lineage") {
    const handle = authority.kind === "work" ? authority.workHandle : authority.rootThreadRef;
    const named = await owners.workNamed(projectId, handle);
    if (!named || named.handle === handle) return null;
    const address = formatParsedContextUri("scratch", "", authority);
    const reached =
      authority.kind === "work"
        ? `Work ${handle} "${(await owners.work(projectId, handle))?.name ?? ""}"`
        : `chat ${handle}'s notes`;
    return `${address} is ${reached}. The Work named "${handle}" is ${named.handle} at ${workAddress(named.handle)}… .`;
  }

  if (authority.kind !== "contextual") return null;
  const first = classifyHandleToken(path.split("/")[0] ?? "");
  if (first.kind !== "handle") return null;
  const { handle, kind } = first.handle;
  if (kind === "work") {
    const work = await owners.work(projectId, handle);
    if (!work || work.state === "deleted") return null;
    return `${requestedPath} is a folder named ${handle} in this chat's notes, written to ${canonicalUri}. Work ${handle} "${work.name}" is at ${workAddress(handle)}… .`;
  }
  if (kind === "chat") {
    const files = await owners.chat(projectId, handle);
    if (!files) return null;
    return `${requestedPath} is a folder named ${handle} in this chat's notes, written to ${canonicalUri}. Chat ${handle}'s notes are at ${files.scratch}… .`;
  }
  return null;
}
