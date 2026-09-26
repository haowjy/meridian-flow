/** Document commands over the project context routes: read, put (seed), rm. */
import { randomUUID } from "node:crypto";
import {
  apiProjectContextCreatePath,
  apiProjectContextDeletePath,
  apiProjectContextReadPath,
  type ContextReadResponse,
  type DeleteContextEntryRequest,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../cli-error";
import {
  type CommandSpec,
  flag,
  readValueArg,
  requirePositional,
  resolveProjectId,
  stringOption,
} from "../command";
import { type ResolvedUri, resolveDocumentId, resolveUri } from "../context-uri";
import { truncate } from "../output";
import type { Session } from "../session";

const PROJECT_OPTION = {
  project: { type: "string" as const, description: "Project id, or `default` (default)" },
  work: { type: "string" as const, description: "Work for scratch/uploads URIs: @slug or @/" },
};

async function deleteDocument(session: Session, projectId: string, target: ResolvedUri) {
  const documentId = await resolveDocumentId(session, projectId, target);
  const body: DeleteContextEntryRequest = {
    operationId: randomUUID(),
    path: target.path,
    expected: { kind: "file", documentId: documentId as never },
  };
  await session.request(
    "POST",
    apiProjectContextDeletePath(projectId, target.scheme, { workId: target.workId }),
    body,
  );
  return documentId;
}

/** Creates (or with overwrite, replaces) a tracked markdown document; returns its id. */
export async function putDocument(
  session: Session,
  input: { projectId: string; uri: string; content: string; work?: string; overwrite: boolean },
): Promise<{ uri: string; documentId: string; replaced: boolean }> {
  const target = await resolveUri(session, input.projectId, input.uri, input.work);
  const create = () =>
    session.request<{ status: string; documentId?: string }>(
      "POST",
      apiProjectContextCreatePath(input.projectId, target.scheme, { workId: target.workId }),
      { type: "file", path: target.path, content: input.content },
    );
  try {
    const created = await create();
    return { uri: target.uri, documentId: String(created.documentId), replaced: false };
  } catch (error) {
    const conflict =
      error instanceof CliError &&
      (error.details as { status?: unknown } | undefined)?.status === "conflict";
    if (!conflict) throw error;
    if (!input.overwrite) {
      throw new CliError("usage", `${target.uri} already exists`, {
        hint: "Pass --overwrite to replace it.",
      });
    }
    await deleteDocument(session, input.projectId, target);
    const created = await create();
    return { uri: target.uri, documentId: String(created.documentId), replaced: true };
  }
}

export const docReadCommand: CommandSpec = {
  path: ["doc", "read"],
  summary: "Print a document's markdown projection",
  args: "<uri>",
  route: "GET /api/projects/:projectId/context/:scheme/read",
  options: { ...PROJECT_OPTION, full: { type: "boolean", description: "No truncation" } },
  examples: [
    "./mf doc read manuscript://chapter-1.md",
    "./mf doc read scratch://@arc-3/notes.md --json",
  ],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const target = await resolveUri(
      session,
      projectId,
      requirePositional(ctx, 0, "<uri>"),
      stringOption(ctx, "work"),
    );
    const response = await session.request<ContextReadResponse>(
      "GET",
      apiProjectContextReadPath(projectId, target.scheme, target.path, { workId: target.workId }),
    );
    const full = flag(ctx, "full");
    ctx.out.result({ uri: target.uri, ...response }, (value) =>
      value.kind === "tracked"
        ? full
          ? value.content
          : truncate(value.content, 8_000)
        : `(binary ${value.mimeType}) ${value.url}`,
    );
    return undefined;
  },
};

export const docPutCommand: CommandSpec = {
  path: ["doc", "put"],
  summary: "Create a markdown document (seed content)",
  args: "<uri>",
  route: "POST /api/projects/:projectId/context/:scheme/create",
  options: {
    ...PROJECT_OPTION,
    text: { type: "string", description: "Content (literal, @file, or - for stdin)" },
    overwrite: { type: "boolean", description: "Replace an existing document" },
  },
  examples: [
    `./mf doc put manuscript://chapter-1.md --text "# Chapter 1"`,
    "./mf doc put kb://characters/lin.md --text @notes/lin.md --overwrite",
  ],
  async run(ctx) {
    const raw = stringOption(ctx, "text");
    if (raw === undefined) throw usageError("--text is required (literal, @file, or -)");
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const result = await putDocument(session, {
      projectId,
      uri: requirePositional(ctx, 0, "<uri>"),
      content: readValueArg(raw),
      work: stringOption(ctx, "work"),
      overwrite: flag(ctx, "overwrite"),
    });
    ctx.out.result(
      { projectId, ...result },
      (value) => `${value.replaced ? "replaced" : "created"} ${value.uri} (${value.documentId})`,
    );
    return undefined;
  },
};

export const docRmCommand: CommandSpec = {
  path: ["doc", "rm"],
  summary: "Delete a document",
  args: "<uri>",
  route: "POST /api/projects/:projectId/context/:scheme/delete",
  options: PROJECT_OPTION,
  examples: ["./mf doc rm manuscript://chapter-1.md"],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const target = await resolveUri(
      session,
      projectId,
      requirePositional(ctx, 0, "<uri>"),
      stringOption(ctx, "work"),
    );
    const documentId = await deleteDocument(session, projectId, target);
    ctx.out.result(
      { uri: target.uri, documentId, status: "deleted" },
      (value) => `deleted ${value.uri}`,
    );
    return undefined;
  },
};
