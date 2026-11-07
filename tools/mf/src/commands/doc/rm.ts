/** `doc rm`: delete a document; `deleteDocument` is shared with put --overwrite. */
import { randomUUID } from "node:crypto";
import {
  apiProjectContextEntryDeletePath,
  type DeleteContextEntryRequest,
  deleteContextEntryResultSchema,
} from "@meridian/contracts/protocol";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import type { Session } from "../../core/session";
import { jsonResponse } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { PROJECT_OPTION, type ResolvedUri, resolveDocumentId, resolveUri } from "./uri";

export async function deleteDocument(session: Session, projectId: string, target: ResolvedUri) {
  const documentId = await resolveDocumentId(session, projectId, target);
  const body: DeleteContextEntryRequest = {
    operationId: randomUUID(),
    kind: "file",
  };
  await session.request("POST", apiProjectContextEntryDeletePath(projectId, documentId), body, {
    decode: jsonResponse(
      deleteContextEntryResultSchema.refine(
        (response) => response.removed.some((removed) => removed.documentId === documentId),
        "Deletion did not cover the requested document",
      ),
    ),
  });
  return documentId;
}

export const docRmCommand: CommandSpec = {
  path: ["doc", "rm"],
  summary: "Delete a document",
  args: "<uri>",
  route: "POST /api/projects/:projectId/context/entries/:entryId/delete",
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
    const documentId = await deleteDocument(session, projectId, target);
    ctx.out.result(
      { uri: target.uri, documentId, status: "deleted" },
      (value) => `deleted ${value.uri}`,
    );
    return undefined;
  },
};
