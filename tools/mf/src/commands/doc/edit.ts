/** `doc edit`: the writer types over text in Live or a draft, as a tab's editor sends it. */
import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { resolveProjectId } from "../project/resolve";
import { writeMarkdown } from "./document-room";
import { PROJECT_OPTION, resolveDocumentId, resolveUri } from "./uri";

export const docEditCommand: CommandSpec = {
  path: ["doc", "edit"],
  summary: "Type over text as the writer: select one passage in Live or a draft and type",
  args: "<uri>",
  route: "WS /ws/loro live:<doc> (and fork:<draft>:<doc>) batch",
  options: {
    ...PROJECT_OPTION,
    find: { type: "string", description: "The text to type over (must occur once)" },
    replace: { type: "string", description: "What the writer types instead" },
    draft: { type: "string", description: "Type in this draft's fork instead of Live" },
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
    const documentId = await resolveDocumentId(session, projectId, target);
    const at = (current: string) => {
      const found = current.indexOf(find);
      if (found < 0 || current.indexOf(find, found + 1) >= 0)
        throw new CliError("not_found", `"${find}" does not occur exactly once`);
      return found;
    };
    // As a writer selects the passage and types: the selection is deleted, then the new words
    // go in, so none of the old characters stand in for the new ones.
    let found = -1;
    await writeMarkdown(
      session,
      documentId,
      (current) => {
        found = at(current);
        return current.slice(0, found) + current.slice(found + find.length);
      },
      undefined,
      draft,
    );
    if (replace)
      await writeMarkdown(
        session,
        documentId,
        (current) => current.slice(0, found) + replace + current.slice(found),
        undefined,
        draft,
      );
    ctx.out.result(
      { uri: target.uri, documentId, ...(draft ? { draft } : {}), status: "edited" },
      (value) => `edited ${value.uri}${draft ? ` in draft ${draft}` : ""}`,
    );
    return undefined;
  },
};
