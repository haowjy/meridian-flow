import {
  apiProjectDocumentReadPath,
  contextReadResponseSchema,
  documentFilenameAt,
  readSegment,
  renderFilename,
} from "@meridian/contracts/protocol";
import { type CreateRecord, isSourceRoot, LIVE, newId, segmentOf } from "@meridian/project-tree";
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
import { writeMarkdown } from "./document-room";
import { deleteAt } from "./rm";
import { lookupPath, Trees, uriIn } from "./tree-address";
import { PROJECT_OPTION, resolveUri } from "./uri";

/**
 * Creates a markdown document through the tree list, then writes its text through the document's
 * room; returns its id. With overwrite, an existing document is deleted first and a new one made
 * at the same URI (new id; the old drafts and history go).
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
  const parsedName = documentFilenameAt(target.scheme, target.path);
  if (!parsedName.ok) throw usageError(parsedName.error.message);
  const kept = parsedName.value.filetype === "source";
  if (!kept && parsedName.value.extension)
    throw usageError(
      `doc put creates markdown documents: drop .${parsedName.value.extension} from ${target.uri}`,
    );
  const stem = renderFilename(parsedName.value.name, parsedName.value.extension);
  const trees = new Trees(session, input.projectId);
  try {
    const opened = await trees.at(target);
    let previousDocumentId: string | null = null;
    const existing = lookupPath(opened.list.replay(), opened.source, target.path).node;
    if (existing && input.overwrite) {
      previousDocumentId = await deleteAt(opened, target);
    }
    let created: CreateRecord;
    try {
      const { parent, missing } = lookupPath(opened.list.replay(), opened.source, target.path);
      created = (
        await opened.list.append((writer) => {
          // A `~id` that reached no folder names none: it is made under its name.
          const made = missing.map((segment) => ({
            name: readSegment(segment).name,
            kind: "folder" as const,
            node: newId(),
          }));
          let at = parent;
          return writer.createAll(LIVE, opened.actor, [
            ...made.map((folder) => {
              const input = { ...folder, parent: at };
              at = folder.node;
              return input;
            }),
            {
              name: stem,
              parent: at,
              kind: "document" as const,
              filetype: kept ? "source" : "markdown",
            },
          ]);
        })
      ).at(-1) as CreateRecord;
    } catch (error) {
      if (previousDocumentId === null) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(
        error instanceof CliError ? error.code : "protocol",
        `${target.uri}: the existing document (${previousDocumentId}) was already deleted, and creating its replacement failed: ${reason}`,
        {
          hint: `Re-run ./mf doc put ${target.uri} to create it; the old document and its drafts are not recoverable here.`,
          details: { previousDocumentId, deleted: true },
          httpStatus: error instanceof CliError ? error.httpStatus : undefined,
        },
      );
    }
    if (input.content.trim() !== "") {
      const stored = async () => {
        const read = await session.request(
          "GET",
          apiProjectDocumentReadPath(input.projectId, created.node),
          undefined,
          { decode: jsonResponse(contextReadResponseSchema) },
        );
        return read.kind === "tracked" && read.content.trim() !== "";
      };
      await writeMarkdown(
        session,
        created.node,
        input.content,
        stored,
        kept ? "source" : undefined,
      );
    }
    // The path it landed at: a twin's segment carries its `~id`.
    const shown = opened.list.replay();
    const landed: string[] = [];
    for (let at = shown.nodes.get(created.node); at; ) {
      landed.unshift(segmentOf(at));
      at = isSourceRoot(at.parent) ? undefined : shown.nodes.get(at.parent);
    }
    return {
      uri: uriIn(opened.source, landed.join("/")),
      documentId: created.node,
      replaced: previousDocumentId !== null,
      previousDocumentId,
    };
  } finally {
    await trees.close();
  }
}

export const docPutCommand: CommandSpec = {
  path: ["doc", "put"],
  summary:
    "Create a markdown document (seed content); --overwrite deletes and recreates it (new id)",
  args: "<uri>",
  route: "WS /ws/yjs tree:project:<projectId> create record, then the document's room",
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
