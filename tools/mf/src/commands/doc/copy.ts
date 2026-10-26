/** `doc copy`: one Copy command through the project's own route. */
import { randomUUID } from "node:crypto";
import {
  apiProjectContextCatalogPath,
  apiProjectContextCopyPath,
  type CatalogLookupResult,
  type ContextSiblingPosition,
  type CopyContextEntrySource,
  copyContextEntriesResultSchema,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, stringOption } from "../../core/command";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { resolveProjectId, resolveWork } from "../project/resolve";
import { resolveThreadId } from "../thread/resolve";
import { PROJECT_OPTION, type ResolvedUri, resolveDocument, resolveUri } from "./uri";

/** The read view every tracked source is copied through. */
type SourceView = { kind: "live" } | { kind: "draft"; workId: string; threadId: string };

export const docCopyCommand: CommandSpec = {
  path: ["doc", "copy"],
  summary: "Copy documents or folders into one folder (one atomic server command)",
  args: "<source-uri...>",
  route: "POST /api/projects/:projectId/context/copy",
  options: {
    ...PROJECT_OPTION,
    to: {
      type: "string",
      description: "Destination folder URI (required), e.g. manuscript://Act 2 or scratch://@w3/",
    },
    position: {
      type: "string",
      description: "Where the first copy lands: start, end (default), before:<id>, after:<id>",
    },
    "draft-work": {
      type: "string",
      description:
        "Copy every tracked source's draft in this Work instead of its live text (needs --draft-thread)",
    },
    "draft-thread": {
      type: "string",
      description: "The chat whose draft view is read (a cN ref or thread id)",
    },
  },
  examples: [
    './mf doc copy "manuscript://Act 1" --to kb://',
    './mf doc copy "manuscript://Chapter 1" "manuscript://Chapter 2" --to "manuscript://Act 2"',
    './mf doc copy "uploads://@c12/cover.png" --to manuscript://Images',
    './mf doc copy "manuscript://Chapter 3" --to "scratch://@w3/" --draft-work w3 --draft-thread c12',
  ],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const to = stringOption(ctx, "to");
    if (!to) throw usageError("--to <folder-uri> is required");

    const draftWork = stringOption(ctx, "draft-work");
    const draftThread = stringOption(ctx, "draft-thread");
    if ((draftWork === undefined) !== (draftThread === undefined)) {
      throw usageError("--draft-work and --draft-thread go together");
    }
    const view: SourceView | undefined =
      draftWork === undefined || draftThread === undefined
        ? undefined
        : {
            kind: "draft",
            workId: (await resolveWork(session, projectId, draftWork)).id,
            threadId: await resolveThreadId(session, draftThread, projectId),
          };

    if (ctx.positionals.length === 0) throw usageError("Name at least one source URI");
    const sources: CopyContextEntrySource[] = [];
    for (const raw of ctx.positionals) {
      const target = await resolveUri(session, projectId, raw);
      sources.push({
        scheme: target.scheme,
        path: target.path,
        expected: await sourceIdentity(session, projectId, target),
        ...(target.workId ? { workId: target.workId } : {}),
        ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
        ...(target.chatRef ? { chatRef: target.chatRef } : {}),
        ...(view ? { view } : {}),
      });
    }

    const destination = await resolveUri(
      session,
      projectId,
      to,
      stringOption(ctx, "work"),
      stringOption(ctx, "chat"),
    );
    const position = stringOption(ctx, "position");
    const result = await session.request(
      "POST",
      apiProjectContextCopyPath(projectId),
      {
        operationId: randomUUID(),
        sources,
        destinationScheme: destination.scheme,
        destinationFolderPath: destination.path,
        ...(destination.workId ? { destinationWorkId: destination.workId } : {}),
        ...(destination.rootThreadId ? { destinationRootThreadId: destination.rootThreadId } : {}),
        ...(position ? { position: parsePosition(position) } : {}),
      },
      { decode: jsonResponse(copyContextEntriesResultSchema) },
    );
    ctx.out.result(result, (value) =>
      value.entries
        .map(
          (entry) =>
            `copied ${entry.kind === "folder" ? "folder" : "file"} ${entry.path} (${entry.id})`,
        )
        .join("\n"),
    );
    return undefined;
  },
};

/** The identity a source root presents, as the copy's expected source. */
async function sourceIdentity(
  session: Session,
  projectId: string,
  target: ResolvedUri,
): Promise<{ kind: "file" | "folder"; nodeId: string }> {
  try {
    const document = await resolveDocument(session, projectId, target);
    return { kind: "file", nodeId: document.documentId };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_found") throw error;
  }
  const folder = await lookupFolder(session, projectId, target);
  if (folder) return { kind: "folder", nodeId: folder };
  throw new CliError("not_found", `Nothing at ${target.uri} to copy`, {
    hint: "A source is a document or a folder. Check it with `./mf doc read`.",
  });
}

async function lookupFolder(
  session: Session,
  projectId: string,
  target: ResolvedUri,
): Promise<string | null> {
  const search = new URLSearchParams({ uri: target.uri, ...scopeQuery(target) });
  const found = await session.request(
    "GET",
    `${apiProjectContextCatalogPath(projectId, "lookup")}?${search.toString()}`,
    undefined,
    { decode: jsonResponse(catalogLookupResponse) },
  );
  return found.entry?.kind === "folder" ? found.entry.entryId : null;
}

/** The catalog lookup route's scope, from the URI's owner. */
function scopeQuery(target: ResolvedUri): Record<string, string> {
  if (target.chatId) return { scope: "chat", chatId: target.chatId };
  if (target.rootThreadId) return { scope: "lineage", rootThreadId: target.rootThreadId };
  if (target.workId) return { scope: "work", workId: target.workId };
  if (target.scheme === "user") return { scope: "user" };
  return { scope: "project" };
}

/** The lookup route answers only what `./mf` needs: is there a folder at this address? */
const catalogLookupResponse = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: Pick<CatalogLookupResult, "entry"> }
    | { success: false; error: unknown } {
    const entries = (value as { entries?: unknown; entry?: unknown } | null) ?? {};
    if (entries.entry && typeof entries.entry === "object") {
      return { success: true, data: entries as Pick<CatalogLookupResult, "entry"> };
    }
    return { success: true, data: null as unknown as Pick<CatalogLookupResult, "entry"> };
  },
};

function parsePosition(raw: string): ContextSiblingPosition {
  if (raw === "start" || raw === "end") return { kind: raw };
  const [kind, siblingId] = raw.split(":", 2);
  if ((kind === "before" || kind === "after") && siblingId) return { kind, siblingId };
  throw usageError("--position takes start, end, before:<id> or after:<id>");
}
