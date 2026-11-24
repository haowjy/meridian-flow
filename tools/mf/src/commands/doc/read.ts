import {
  apiProjectDocumentReadPath,
  contextReadResponseSchema,
} from "@meridian/contracts/protocol";
import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { truncate } from "../../core/output";
import { jsonResponse } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { readMarkdown } from "./document-room";
import { PROJECT_OPTION, resolveDocument, resolveDocumentRoom, resolveUri } from "./uri";

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
        "Read the document as the draft has it: the path in the draft's tree, through the room the editor opens (WS /ws/loro fork:<draft>:<doc>, or live:<doc> for a document only the draft holds)",
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
      const room = await resolveDocumentRoom(session, projectId, target, draft);
      const content = await readMarkdown(session, room);
      ctx.out.result({ uri: target.uri, draft, content }, (value) => value.content);
      return undefined;
    }
    const { documentId } = await resolveDocument(session, projectId, target);
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
