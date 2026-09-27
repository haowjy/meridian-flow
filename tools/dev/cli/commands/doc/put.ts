import { apiProjectContextCreatePath } from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import {
  type CommandSpec,
  flag,
  readValueArg,
  requirePositional,
  stringOption,
} from "../../core/command";
import type { Session } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { deleteDocument } from "./rm";
import { PROJECT_OPTION, resolveUri } from "./uri";

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
