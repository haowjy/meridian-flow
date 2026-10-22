import {
  apiProjectContextCreatePath,
  createContextFileResponseSchema,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  readValueArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { deleteDocument } from "./rm";
import { ownerOf, PROJECT_OPTION, resolveUri } from "./uri";

/**
 * Creates a tracked markdown document; returns its id. With overwrite, a conflict deletes the
 * existing document and creates a new one at the same URI (new id; the old drafts and history go).
 */
export async function putDocument(
  session: Session,
  input: {
    projectId: string;
    uri: string;
    content: string;
    work?: string;
    chat?: string;
    overwrite: boolean;
  },
): Promise<{
  uri: string;
  documentId: string;
  replaced: boolean;
  previousDocumentId: string | null;
}> {
  const target = await resolveUri(session, input.projectId, input.uri, input.work, input.chat);
  const create = () =>
    session.request(
      "POST",
      apiProjectContextCreatePath(input.projectId, target.scheme, ownerOf(target)),
      { type: "file", path: target.path, content: input.content },
      { decode: jsonResponse(createContextFileResponseSchema) },
    );
  try {
    const created = await create();
    return {
      uri: created.uri,
      documentId: created.documentId,
      replaced: false,
      previousDocumentId: null,
    };
  } catch (error) {
    const conflict =
      error instanceof CliError &&
      (error.details as { status?: unknown } | undefined)?.status === "conflict";
    if (!conflict) throw error;
    if (!input.overwrite) {
      throw new CliError("usage", `${target.uri} already exists`, {
        hint: "Pass --overwrite to delete it and create a new document at this URI (new id, old drafts lost).",
      });
    }
    const previousDocumentId = await deleteDocument(session, input.projectId, target);
    try {
      const created = await create();
      return {
        uri: created.uri,
        documentId: created.documentId,
        replaced: true,
        previousDocumentId,
      };
    } catch (createError) {
      const reason = createError instanceof Error ? createError.message : String(createError);
      throw new CliError(
        createError instanceof CliError ? createError.code : "protocol",
        `${target.uri}: the existing document (${previousDocumentId}) was already deleted, and creating its replacement failed: ${reason}`,
        {
          hint: `Re-run ./mf doc put ${target.uri} to create it; the old document and its drafts are not recoverable here.`,
          details: { previousDocumentId, deleted: true },
          httpStatus: createError instanceof CliError ? createError.httpStatus : undefined,
        },
      );
    }
  }
}

export const docPutCommand: CommandSpec = {
  path: ["doc", "put"],
  summary:
    "Create a markdown document (seed content); --overwrite deletes and recreates it (new id)",
  args: "<uri>",
  route: "POST /api/projects/:projectId/context/:scheme/create",
  options: {
    ...PROJECT_OPTION,
    text: { type: "string", description: "Content (literal, @file, or - for stdin)" },
    overwrite: {
      type: "boolean",
      description:
        "If the URI exists, delete that document and create a new one there (new id; the old drafts and history are lost)",
    },
  },
  examples: [
    `./mf doc put "manuscript://Chapter 1" --text "# Chapter 1"`,
    "./mf doc put kb://characters/Lin --text @notes/lin.md --overwrite",
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
      chat: stringOption(ctx, "chat"),
      overwrite: flag(ctx, "overwrite"),
    });
    ctx.out.result({ projectId, ...result }, (value) =>
      value.replaced
        ? `deleted ${value.previousDocumentId}, created ${value.uri} (${value.documentId})`
        : `created ${value.uri} (${value.documentId})`,
    );
    return undefined;
  },
};
