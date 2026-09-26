/** URI → project context route inputs and live document identity, via the app's own address route. */
import { parseContextUri, WORK_SCOPED_CONTEXT_URI_SCHEMES } from "@meridian/contracts/context-uri";
import {
  apiProjectDocumentAddressPath,
  type DocumentAddressResult,
  type ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "./cli-error";
import { resolveWorkId } from "./command";
import type { Session } from "./session";

export type ResolvedUri = {
  scheme: ProjectContextTreeScheme;
  path: string;
  /** Canonical spelling the admission path requires. */
  uri: string;
  workId: string | null;
};

export async function resolveUri(
  session: Session,
  projectId: string,
  raw: string,
  workOverride?: string,
): Promise<ResolvedUri> {
  const parsed = parseContextUri(raw);
  if (!parsed.ok) throw usageError(`Invalid URI ${raw}: ${parsed.error.reason}`);
  const { scheme, authority, path, normalized } = parsed.value;
  if (!path) throw usageError(`URI ${raw} has no path`);
  const workScoped = (WORK_SCOPED_CONTEXT_URI_SCHEMES as readonly string[]).includes(scheme);
  let workId: string | null = null;
  if (workScoped) {
    const workRaw =
      workOverride ?? (authority.kind === "work" ? `@${authority.workSlug}` : undefined);
    workId = await resolveWorkId(session, projectId, workRaw);
  }
  return { scheme, path, uri: normalized, workId };
}

/** Live documentId for a URI, or a not_found CliError. */
export async function resolveDocumentId(
  session: Session,
  projectId: string,
  target: ResolvedUri,
): Promise<string> {
  const address = await session.request<DocumentAddressResult>(
    "GET",
    apiProjectDocumentAddressPath(projectId, target.scheme, target.path, { workId: target.workId }),
  );
  if (address.kind === "unavailable") {
    throw new CliError("not_found", `No live document at ${target.uri}`, {
      hint: `Create it with \`./mf doc put ${target.uri} --text "..."\`.`,
    });
  }
  return address.document.documentId;
}
