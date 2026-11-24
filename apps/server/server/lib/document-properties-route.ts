import type { DocumentProperties } from "@meridian/contracts";
import { createError } from "nitro/h3";
import {
  type DocumentPropertiesReader,
  parseDocumentProperties,
} from "../domains/context/index.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import { documentTarget, requireFileGrant } from "./file-access-http.js";

export interface DocumentPropertiesRouteDeps {
  fileAccess: Pick<FileAccess, "authorize">;
  projectRepo: Pick<ProjectRepository, "findById">;
  documentProperties: DocumentPropertiesReader;
}

export async function readDocumentPropertiesForRoute(
  deps: DocumentPropertiesRouteDeps,
  input: { userId: string; projectId: string; documentId: string },
): Promise<DocumentProperties> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  await requireFileGrant(deps.fileAccess, input.userId, documentTarget(input.documentId), "read");
  const stored = await deps.documentProperties.findStored(input.documentId);
  if (!stored) throw createError({ statusCode: 404, message: "Document has no properties" });
  return parseDocumentProperties(stored);
}
