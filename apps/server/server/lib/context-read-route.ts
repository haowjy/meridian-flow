import type { DocumentId, ProjectId } from "@meridian/contracts";
import type { ContextReadResponse } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import { fileRefOfVisible, type ProjectContextAvailabilityPort } from "../domains/context/index.js";
import { LIVE_TREE, type TreeReader } from "../domains/context/tree/tree-view.js";
import type { FileAccess } from "../domains/file-policy/index.js";
import { type EventSink, emitEvent } from "../domains/observability/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import {
  drawObjectKey,
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
} from "../domains/storage/index.js";
import type { AppServices } from "./app.js";
import { documentTarget, requireFileGrant } from "./file-access-http.js";

export interface ContextReadRouteDeps {
  fileAccess: Pick<FileAccess, "authorize">;
  projectRepo: ProjectRepository;
  availability: ProjectContextAvailabilityPort;
  liveDocuments: Pick<TreeReader, "findById">;
  documentSync: Pick<AppServices["documentSync"], "readAsMarkdown">;
  links: Pick<AppServices["linkScopes"], "within">;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
}

export async function handleContextReadRequest(
  deps: ContextReadRouteDeps,
  input: { projectId: string; userId: string; documentId: string },
): Promise<ContextReadResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const held = await deps.availability.held(
    {
      projectId: input.projectId as ProjectId,
      node: { kind: "document", id: input.documentId as DocumentId },
    },
    { userId: input.userId },
  );
  if (held?.kind !== "held") throw createError({ statusCode: 404, message: "Document not found" });
  const documentId = held.address.id;
  await requireFileGrant(deps.fileAccess, input.userId, documentTarget(documentId), "read");
  const found = await deps.liveDocuments.findById(LIVE_TREE, documentId as DocumentId);
  if (found.kind !== "found") throw createError({ statusCode: 404, message: "Document not found" });
  const ref = fileRefOfVisible(found.document);
  if (!ref.ok) throw createError({ statusCode: 502, message: "Document storage is inconsistent" });
  if (ref.value.kind === "tracked") {
    const read = await deps.links.within(
      { projectId: input.projectId, viewer: { accountId: input.userId } },
      () => deps.documentSync.readAsMarkdown(documentId),
    );
    if (!read.ok)
      throw createError({
        statusCode: 503,
        message: "The document couldn't be read right now.",
        data: { retryable: true },
      });
    return {
      kind: "tracked",
      content: read.value,
      schemaType: ref.value.schemaType,
      filetype: ref.value.filetype,
    };
  }
  const key = objectStoreKeyFromStorageUrl(ref.value.storageUrl);
  if (!key) throw createError({ statusCode: 502, message: "Context storage URL is invalid" });
  const signed = await deps.objectStore.getSignedUrl(key);
  if (!signed.ok) {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "lib.context-read",
      name: "signed_url.failed",
      payload: {
        projectId: input.projectId,
        uri: held.address.uri,
        storageKey: key,
        error: signed.error,
      },
    });
    if (signed.error.code === "not_found")
      throw createError({ statusCode: 404, message: "Context path not found" });
    throw createError({ statusCode: 502, message: "Failed to resolve context file URL" });
  }
  const mimeType = ref.value.mimeType;
  const drawKey = drawObjectKey({ key, mimeType, hasPreview: ref.value.hasPreview ?? false });
  const drawUrl =
    drawKey === key
      ? signed.value
      : drawKey
        ? await deps.objectStore.getSignedUrl(drawKey).then((r) => (r.ok ? r.value : null))
        : null;
  return {
    kind: "binary",
    url: signed.value,
    ...(drawUrl ? { drawUrl } : {}),
    fileType: ref.value.fileType,
    mimeType,
    sizeBytes: ref.value.sizeBytes ?? null,
  };
}
