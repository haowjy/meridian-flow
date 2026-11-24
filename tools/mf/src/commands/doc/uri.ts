import {
  formatParsedContextUri,
  type ParsedContextAuthority,
  parseContextUri,
} from "@meridian/contracts/context-uri";
import { parseHandle } from "@meridian/contracts/handles";
import {
  apiProjectDocumentAddressPath,
  type ContextOwner,
  type DocumentRoom,
  documentAddressSchema,
  type ProjectContextTreeScheme,
  parseDocumentFilename,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { resolveWork } from "../project/resolve";
import { resolveThreadId } from "../thread/resolve";
import { lookupPath, Trees } from "./tree-address";

export type ResolvedUri = {
  scheme: ProjectContextTreeScheme;
  path: string;
  uri: string;
  workId: string | null;
  rootThreadId: string | null;
  chatRef: string | null;
  chatId: string | null;
};

export function ownerOf(target: ResolvedUri): ContextOwner {
  if (target.chatId) return { chatThreadId: target.chatId };
  if (target.rootThreadId) return { rootThreadId: target.rootThreadId };
  return { workId: target.workId };
}

export async function resolveUri(
  session: Session,
  projectId: string,
  raw: string,
  workOverride?: string,
  chatOverride?: string,
  options: { allowRoot?: boolean } = {},
): Promise<ResolvedUri> {
  const parsed = parseContextUri(raw);
  if (!parsed.ok) throw usageError(`Invalid URI ${raw}: ${parsed.error.reason}`);
  const { scheme, authority, path } = parsed.value;
  if (!path && !options.allowRoot) throw usageError(`URI ${raw} has no path`);
  let workId: string | null = null;
  let chatRef: string | null = null;
  let rootRef: string | null = null;
  let ownerAuthority: ParsedContextAuthority = { kind: "contextual" };
  if (scheme === "uploads") {
    if (workOverride !== undefined)
      throw usageError("uploads belong to a chat: use --chat <c-handle>");
    if (authority.kind === "chat") chatRef = authority.chatRef;
    if (chatOverride !== undefined) {
      if (parseHandle(chatOverride)?.kind !== "chat") {
        throw usageError("--chat takes a chat handle like c12");
      }
      if (chatRef !== null && chatRef !== chatOverride) {
        throw usageError(`URI ${raw} names chat ${chatRef}, not ${chatOverride}`);
      }
      chatRef = chatOverride;
    }
    if (chatRef === null) {
      throw usageError(
        `uploads belong to a chat: use uploads://@<c-handle>/… or --chat <c-handle>`,
      );
    }
    ownerAuthority = { kind: "chat", chatRef };
  } else if (scheme === "scratch") {
    if (workOverride !== undefined) {
      const resolved = await resolveWork(session, projectId, workOverride);
      workId = resolved.id;
      ownerAuthority = { kind: "work", workHandle: resolved.handle };
    } else if (authority.kind === "work") {
      workId = (await resolveWork(session, projectId, authority.workHandle)).id;
      ownerAuthority = authority;
    } else if (authority.kind === "lineage") {
      rootRef = authority.rootThreadRef;
      ownerAuthority = authority;
    } else {
      throw usageError(
        "scratch belongs to a Work or a chat: use scratch://@<w-handle>/…, scratch://@<c-handle>/… or --work <w-handle>",
      );
    }
  }
  const slash = path.lastIndexOf("/");
  if (!path) {
    const uri = formatParsedContextUri(scheme, "", ownerAuthority);
    const chatId = chatRef === null ? null : await resolveThreadId(session, chatRef, projectId);
    const rootThreadId =
      rootRef === null ? null : await resolveThreadId(session, rootRef, projectId);
    return { scheme, path: "", uri, workId, chatRef, chatId, rootThreadId };
  }
  const parsedName = parseDocumentFilename(path.slice(slash + 1));
  if (!parsedName.ok) throw usageError(parsedName.error.message);
  const uri = formatParsedContextUri(scheme, path, ownerAuthority);
  const chatId = chatRef === null ? null : await resolveThreadId(session, chatRef, projectId);
  const rootThreadId = rootRef === null ? null : await resolveThreadId(session, rootRef, projectId);
  return { scheme, path, uri, workId, chatRef, chatId, rootThreadId };
}

export async function resolveDocument(session: Session, projectId: string, target: ResolvedUri) {
  const address = await session.request(
    "GET",
    apiProjectDocumentAddressPath(projectId, target.scheme, target.path, ownerOf(target)),
    undefined,
    { decode: jsonResponse(documentAddressSchema) },
  );
  if (address.kind === "unavailable") {
    throw new CliError("not_found", `No live document at ${target.uri}`, {
      hint: `Create it with \`./mf doc put ${target.uri} --text "..."\`.`,
    });
  }
  return address.document;
}

export async function resolveDocumentRoom(
  session: Session,
  projectId: string,
  target: ResolvedUri,
  draft?: string,
): Promise<DocumentRoom> {
  if (!draft) {
    const { documentId } = await resolveDocument(session, projectId, target);
    return { kind: "live", documentId };
  }
  const trees = new Trees(session, projectId);
  try {
    const { list, source } = await trees.at(target);
    const { node } = lookupPath(list.replay({ draft }), source, target.path);
    if (node?.kind !== "document")
      throw new CliError("not_found", `No document at ${target.uri} in draft ${draft}`);
    return list.onlyInDraft(node.id, draft)
      ? { kind: "live", documentId: node.id }
      : { kind: "fork", draftId: draft, documentId: node.id };
  } finally {
    await trees.close();
  }
}

export const PROJECT_OPTION = {
  project: { type: "string" as const, description: "Project id, or `default` (default)" },
  work: { type: "string" as const, description: "Work for scratch URIs: its handle, such as w3" },
  chat: { type: "string" as const, description: "Chat handle for uploads URIs: c12" },
};
