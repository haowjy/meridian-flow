/** `doc copy`: one Copy command through the project's own route, its sources named by the tree list. */
import { randomUUID } from "node:crypto";
import {
  apiProjectContextCopyPath,
  type ContextSiblingPosition,
  type CopyContextEntrySource,
  type CopyContextEntryView,
  copyContextEntriesResultSchema,
} from "@meridian/contracts/protocol";
import { CliError, usageError } from "../../core/cli-error";
import { type CommandSpec, stringOption } from "../../core/command";
import { jsonResponse } from "../../core/session";
import { resolveProjectId, resolveWork } from "../project/resolve";
import { lookupPath, Trees } from "./tree-address";
import { PROJECT_OPTION, type ResolvedUri, resolveUri } from "./uri";

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
        "Copy every tracked source's draft in this Work instead of its live text; a Work with no draft of a source refuses",
    },
  },
  examples: [
    './mf doc copy "manuscript://Act 1" --to kb://',
    './mf doc copy "manuscript://Chapter 1" "manuscript://Chapter 2" --to "manuscript://Act 2"',
    './mf doc copy "uploads://@c12/cover.png" --to manuscript://Images',
    './mf doc copy "manuscript://Chapter 3" --to "scratch://@w3/" --draft-work w3',
  ],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const to = stringOption(ctx, "to");
    if (!to) throw usageError("--to <folder-uri> is required");

    const draftWork = stringOption(ctx, "draft-work");
    const view: CopyContextEntryView | undefined =
      draftWork === undefined
        ? undefined
        : {
            kind: "draft",
            owner: `work:${(await resolveWork(session, projectId, draftWork)).id}`,
          };

    if (ctx.positionals.length === 0) throw usageError("Name at least one source URI");
    const sources: CopyContextEntrySource[] = [];
    const trees = new Trees(session, projectId);
    try {
      for (const raw of ctx.positionals) {
        const target = await resolveUri(session, projectId, raw);
        sources.push({
          scheme: target.scheme,
          path: target.path,
          expected: await sourceIdentity(trees, target),
          ...(target.workId ? { workId: target.workId } : {}),
          ...(target.rootThreadId ? { rootThreadId: target.rootThreadId } : {}),
          ...(target.chatRef ? { chatRef: target.chatRef } : {}),
          ...(view ? { view } : {}),
        });
      }
    } finally {
      await trees.close();
    }

    const destination = await resolveUri(
      session,
      projectId,
      to,
      stringOption(ctx, "work"),
      stringOption(ctx, "chat"),
      { allowRoot: true },
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

/** The identity a source root presents, as the copy's expected source: the node the list holds there. */
async function sourceIdentity(
  trees: Trees,
  target: ResolvedUri,
): Promise<{ kind: "file" | "folder"; nodeId: string }> {
  const { list, source } = await trees.at(target);
  const { node } = lookupPath(list.replay(), source, target.path);
  if (!node)
    throw new CliError("not_found", `Nothing at ${target.uri} to copy`, {
      hint: "A source is a document or a folder. Check it with `./mf doc read`.",
    });
  return { kind: node.kind === "folder" ? "folder" : "file", nodeId: node.id };
}

function parsePosition(raw: string): ContextSiblingPosition {
  if (raw === "start" || raw === "end") return { kind: raw };
  const [kind, siblingId] = raw.split(":", 2);
  if ((kind === "before" || kind === "after") && siblingId) return { kind, siblingId };
  throw usageError("--position takes start, end, before:<id> or after:<id>");
}
