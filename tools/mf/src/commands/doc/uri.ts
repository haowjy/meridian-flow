/** URI → project context route inputs and live document identity, via the app's own address route. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import {
  apiProjectDocumentAddressPath,
  type ContextOwner,
  type DocumentAddressResult,
  type ProjectContextTreeScheme,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";

import type { Session } from "../../core/session";
import { resolveWorkId } from "../project/resolve";
import { resolveThreadId } from "../thread/resolve";

export type ResolvedUri = {
  scheme: ProjectContextTreeScheme;
  path: string;
  /** Canonical spelling the admission path requires. */
  uri: string;
  workId: string | null;
  /** The chat whose uploads an `uploads://` URI names; null for every other scheme. */
  chatRef: string | null;
  /** The chat's thread id, which the server's `chatId` query takes; null unless `chatRef` is set. */
  chatId: string | null;
};

/** The owner the context route helpers send: the chat for uploads, else the Work. */
export function ownerOf(target: ResolvedUri): ContextOwner {
  return target.chatId ? { chatThreadId: target.chatId } : { workId: target.workId };
}

export async function resolveUri(
  session: Session,
  projectId: string,
  raw: string,
  workOverride?: string,
  chatOverride?: string,
): Promise<ResolvedUri> {
  const parsed = parseContextUri(raw);
  if (!parsed.ok) throw usageError(`Invalid URI ${raw}: ${parsed.error.reason}`);
  const { scheme, authority, path, normalized } = parsed.value;
  if (!path) throw usageError(`URI ${raw} has no path`);
  let workId: string | null = null;
  let chatRef: string | null = null;
  if (scheme === "uploads") {
    if (workOverride !== undefined)
      throw usageError("uploads belong to a chat: use --chat <c-handle>");
    if (authority.kind === "chat") chatRef = authority.chatRef;
    if (chatOverride !== undefined) {
      if (!/^c[1-9][0-9]*$/.test(chatOverride)) {
        throw usageError("--chat takes a chat handle like c12");
      }
      if (chatRef !== null && chatRef !== chatOverride) {
        throw usageError(`URI ${raw} names chat ${chatRef}, not ${chatOverride}`);
      }
      chatRef = chatOverride;
    }
    if (chatRef === null) {
      throw usageError(
        `uploads belong to a chat: use uploads://@/<c-handle>/… or --chat <c-handle>`,
      );
    }
  } else if (scheme === "scratch") {
    const workRaw =
      workOverride ?? (authority.kind === "work" ? `@${authority.workSlug}` : undefined);
    workId = await resolveWorkId(session, projectId, workRaw);
  }
  const slash = path.lastIndexOf("/");
  const parsedName = parseDocumentFilename(path.slice(slash + 1));
  if (!parsedName.ok) throw usageError(parsedName.error.message);
  const canonicalPath =
    path.slice(0, slash + 1) + renderFilename(parsedName.value.name, parsedName.value.extension);
  const prefix =
    chatRef !== null
      ? `uploads://@/${chatRef}/`
      : normalized.slice(0, normalized.length - path.length);
  const chatId = chatRef === null ? null : await resolveThreadId(session, chatRef, projectId);
  return { scheme, path: canonicalPath, uri: prefix + canonicalPath, workId, chatRef, chatId };
}

/** Live documentId for a URI, or a not_found CliError. */
export async function resolveDocument(session: Session, projectId: string, target: ResolvedUri) {
  const address = await session.request<DocumentAddressResult>(
    "GET",
    apiProjectDocumentAddressPath(projectId, target.scheme, target.path, ownerOf(target)),
  );
  if (address.kind === "unavailable") {
    throw new CliError("not_found", `No live document at ${target.uri}`, {
      hint: `Create it with \`./mf doc put ${target.uri} --text "..."\`.`,
    });
  }
  return address.document;
}

export async function resolveDocumentId(
  session: Session,
  projectId: string,
  target: ResolvedUri,
): Promise<string> {
  return (await resolveDocument(session, projectId, target)).documentId;
}

/** `--project`/`--work`/`--chat` shared by every command that takes a document URI. */
export const PROJECT_OPTION = {
  project: { type: "string" as const, description: "Project id, or `default` (default)" },
  work: { type: "string" as const, description: "Work for scratch URIs: @slug or @/" },
  chat: { type: "string" as const, description: "Chat handle for uploads URIs: c12" },
};
