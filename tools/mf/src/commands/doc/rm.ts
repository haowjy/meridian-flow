/** `doc rm`: delete a document; `deleteAt` is shared with put --overwrite. */
import { LIVE } from "@meridian/project-tree";
import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import { resolveProjectId } from "../project/resolve";
import { lookupPath, type OpenedTree, Trees } from "./tree-address";
import { PROJECT_OPTION, type ResolvedUri, resolveUri } from "./uri";

/** Appends the delete of the document at `target` and waits for the server to admit it; returns its id. */
export async function deleteAt(opened: OpenedTree, target: ResolvedUri): Promise<string> {
  const { node } = lookupPath(opened.list.replay(), opened.source, target.path);
  if (!node) throw new CliError("not_found", `No live document at ${target.uri}`);
  if (node.kind === "folder")
    throw usageError(`${target.uri} is a folder; \`doc rm\` deletes documents`);
  await opened.list.append((writer) => writer.deleteAll(LIVE, opened.actor, [node.id]));
  return node.id;
}

export const docRmCommand: CommandSpec = {
  path: ["doc", "rm"],
  summary: "Delete a document",
  args: "<uri>",
  route: "WS /ws/yjs tree:project:<projectId> delete record",
  options: PROJECT_OPTION,
  examples: ['./mf doc rm "manuscript://Chapter 1"'],
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
    const trees = new Trees(session, projectId);
    try {
      const documentId = await deleteAt(await trees.at(target), target);
      ctx.out.result(
        { uri: target.uri, documentId, status: "deleted" },
        (value) => `deleted ${value.uri}`,
      );
    } finally {
      await trees.close();
    }
    return undefined;
  },
};
