import {
  apiProjectDocumentReadPath,
  contextReadResponseSchema,
} from "@meridian/contracts/protocol";
import { CliError } from "../../core/cli-error";
import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { truncate } from "../../core/output";
import { jsonResponse, type Session } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { readMarkdown } from "./document-room";
import { lookupPath, Trees } from "./tree-address";
import { PROJECT_OPTION, type ResolvedUri, resolveDocumentId, resolveUri } from "./uri";

export const docReadCommand: CommandSpec = {
  path: ["doc", "read"],
  summary: "Print a document's markdown projection",
  args: "<uri>",
  route: "GET /api/projects/:projectId/documents/:documentId/read",
  options: {
    ...PROJECT_OPTION,
    full: { type: "boolean", description: "No truncation" },
    draft: {
      type: "string",
      description:
        "Read the draft's fork instead: the path as the draft has it, through its room (WS /ws/loro fork:<draft>:<doc>)",
    },
  },
  examples: [
    './mf doc read "manuscript://Chapter 1"',
    "./mf doc read scratch://@w3/notes --json",
    './mf doc read "manuscript://Chapter 1" --draft k3x9a0b1c2d4',
  ],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const target = await resolveUri(
      session,
      projectId,
      requirePositional(ctx, 0, "<uri>"),
      stringOption(ctx, "work"),
      stringOption(ctx, "chat"),
    );
    const draft = stringOption(ctx, "draft");
    if (draft) {
      const documentId = await documentInDraft(session, projectId, target, draft);
      const content = await readMarkdown(session, documentId, draft);
      ctx.out.result({ uri: target.uri, draft, content }, (value) => value.content);
      return undefined;
    }
    const documentId = await resolveDocumentId(session, projectId, target);
    const response = await session.request(
      "GET",
      apiProjectDocumentReadPath(projectId, documentId),
      undefined,
      { decode: jsonResponse(contextReadResponseSchema) },
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

/** The document at the URI's path in the draft's view of the tree, which holds what only the draft made. */
async function documentInDraft(
  session: Session,
  projectId: string,
  target: ResolvedUri,
  draft: string,
): Promise<string> {
  const trees = new Trees(session, projectId);
  try {
    const { list, source } = await trees.at(target);
    const { node } = lookupPath(list.replay({ draft }), source, target.path);
    if (node?.kind !== "document")
      throw new CliError("not_found", `No document at ${target.uri} in draft ${draft}`);
    return node.id;
  } finally {
    await trees.close();
  }
}
