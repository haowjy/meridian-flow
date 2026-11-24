/** `doc edit`: the writer types over text in Live or a draft, as a tab's editor sends it. */
import { usageError } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { resolveProjectId } from "../project/resolve";
import { typeOver } from "./document-room";
import { PROJECT_OPTION, resolveDocumentRoom, resolveUri } from "./uri";

export const docEditCommand: CommandSpec = {
  path: ["doc", "edit"],
  summary: "Type over text as the writer: select one passage in Live or a draft and type",
  args: "<uri>",
  route: "WS /ws/loro live:<doc> (and fork:<draft>:<doc>) batch",
  options: {
    ...PROJECT_OPTION,
    find: { type: "string", description: "The text to type over (once, inside one paragraph)" },
    replace: { type: "string", description: "What the writer types instead" },
    draft: {
      type: "string",
      description:
        "Type in this draft instead of Live: its fork, or Live's room for a document only the draft holds",
    },
  },
  examples: ['./mf doc edit "manuscript://Chapter 1" --find "rang" --replace "tolled"'],
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
    const find = stringOption(ctx, "find");
    const replace = stringOption(ctx, "replace");
    if (!find || replace === undefined) throw usageError("--find and --replace are required");
    const draft = stringOption(ctx, "draft");
    const room = await resolveDocumentRoom(session, projectId, target, draft);
    await typeOver(session, room, find, replace);
    ctx.out.result(
      {
        uri: target.uri,
        documentId: room.documentId,
        ...(draft ? { draft } : {}),
        status: "edited",
      },
      (value) => `edited ${value.uri}${draft ? ` in draft ${draft}` : ""}`,
    );
    return undefined;
  },
};
