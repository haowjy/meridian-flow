/** `doc rm`: delete a document; `deleteDocument` is shared with put --overwrite. */
import { randomUUID } from "node:crypto";
import {
  apiProjectContextDeletePath,
  type DeleteContextEntryRequest,
} from "@meridian/contracts/protocol";
import { type CommandSpec, requirePositional, stringOption } from "../../core/command";
import type { Session } from "../../core/session";
import { resolveProjectId } from "../project/resolve";
import { PROJECT_OPTION, type ResolvedUri, resolveDocumentId, resolveUri } from "./uri";

export async function deleteDocument(session: Session, projectId: string, target: ResolvedUri) {
  const documentId = await resolveDocumentId(session, projectId, target);
  const body: DeleteContextEntryRequest = {
    operationId: randomUUID(),
    path: target.path,
    expected: { kind: "file", documentId: documentId as never },
  };
  await session.request(
    "POST",
    apiProjectContextDeletePath(projectId, target.scheme, { workId: target.workId }),
    body,
  );
  return documentId;
}

export const docRmCommand: CommandSpec = {
  path: ["doc", "rm"],
  summary: "Delete a document",
  args: "<uri>",
  route: "POST /api/projects/:projectId/context/:scheme/delete",
  options: PROJECT_OPTION,
  examples: ["./mf doc rm manuscript://chapter-1.md"],
  async run(ctx) {
    const session = await ctx.session();
    const projectId = await resolveProjectId(session, stringOption(ctx, "project"));
    const target = await resolveUri(
      session,
      projectId,
      requirePositional(ctx, 0, "<uri>"),
      stringOption(ctx, "work"),
    );
    const documentId = await deleteDocument(session, projectId, target);
    ctx.out.result(
      { uri: target.uri, documentId, status: "deleted" },
      (value) => `deleted ${value.uri}`,
    );
    return undefined;
  },
};
