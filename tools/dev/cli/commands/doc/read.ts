import { apiProjectContextReadPath, type ContextReadResponse } from "@meridian/contracts/protocol";
import { type CommandSpec, flag, requirePositional, stringOption } from "../../core/command";
import { truncate } from "../../core/output";
import { resolveProjectId } from "../project/resolve";
import { PROJECT_OPTION, resolveUri } from "./uri";

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
