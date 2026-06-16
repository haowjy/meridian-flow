/** GET /api/projects/[projectId]/context/[scheme]/tree — project context file tree. */
import {
  type ProjectContextTreeDirectory,
  type ProjectContextTreeFile,
  type ProjectContextTreeNode,
  type ProjectContextTreeResponse,
  type ProjectContextTreeScheme,
  serializeTransport,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getQuery, getRouterParam } from "nitro/h3";
import {
  projectBrowseContextUri,
  WORK_SCOPED_BROWSE_SCHEMES,
  workScopedBrowseUri,
} from "../../../../../../domains/context/browse-layer-scheme.js";
import { contextPortForProjectBrowse } from "../../../../../../domains/context/context-port-resolution.js";
import type { ContextError, FileEntry } from "../../../../../../domains/context/index.js";
import type { ContextPort } from "../../../../../../domains/context/ports/context-port.js";
import { requireProjectOwner } from "../../../../../../domains/projects/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

const ROOT_NAMES: Record<ProjectContextTreeScheme, string> = {
  manuscript: "Manuscript",
  kb: "Knowledge Base",
  work: "Work",
  uploads: "Uploads",
  user: "User Files",
};

function parseScheme(value: string): ProjectContextTreeScheme {
  if (
    value === "manuscript" ||
    value === "kb" ||
    value === "work" ||
    value === "uploads" ||
    value === "user"
  ) {
    return value;
  }
  throw createError({ statusCode: 400, message: `Unsupported context scheme: ${value}` });
}

function contextErrorToHttp(error: ContextError): never {
  switch (error.code) {
    case "invalid_uri":
      throw createError({ statusCode: 400, message: error.reason });
    case "permission_denied":
      throw createError({ statusCode: 403, message: "Context access denied" });
    case "not_found":
      throw createError({ statusCode: 404, message: "Context path not found" });
    case "conflict":
      throw createError({ statusCode: 409, message: "Context path conflict" });
    case "invalid_operation":
      throw createError({ statusCode: 400, message: "Invalid context operation" });
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}

function rootUri(scheme: ProjectContextTreeScheme, workId: string | null): string {
  if (WORK_SCOPED_BROWSE_SCHEMES.has(scheme)) {
    if (!workId) throw createError({ statusCode: 400, message: "`workId` is required" });
    return workScopedBrowseUri(scheme as "work" | "uploads", workId);
  }
  return projectBrowseContextUri(scheme, "");
}

function pathFromUri(uri: string, root: string): string {
  if (!uri.startsWith(root))
    throw createError({ statusCode: 502, message: `Unexpected context URI: ${uri}` });
  const path = uri.slice(root.length).replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "/";
}

function nameFromPath(path: string): string {
  if (path === "/") return "";
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function sortTree(nodes: ProjectContextTreeNode[]): ProjectContextTreeNode[] {
  return nodes.sort((a, b) =>
    a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
  );
}

async function listEntries(port: ContextPort, uri: string): Promise<FileEntry[]> {
  const result = await port.list(uri);
  if (!result.ok) contextErrorToHttp(result.error);
  return result.value;
}

async function buildDirectory(
  port: ContextPort,
  root: string,
  uri: string,
  name: string,
): Promise<ProjectContextTreeDirectory> {
  const path = pathFromUri(uri, root);
  const entries = await listEntries(port, uri);
  const children: ProjectContextTreeNode[] = [];
  for (const entry of entries) {
    const entryPath = pathFromUri(entry.uri, root);
    if (entry.kind === "directory") {
      children.push(await buildDirectory(port, root, entry.uri, nameFromPath(entryPath)));
      continue;
    }
    if (!entry.documentId)
      throw createError({
        statusCode: 502,
        message: `Context file is missing persisted document id: ${entry.uri}`,
      });
    const file: ProjectContextTreeFile = {
      kind: "file",
      documentId: entry.documentId,
      name: nameFromPath(entryPath),
      path: entryPath,
      uri: entry.uri,
      sizeBytes: entry.sizeBytes,
      updatedAt: entry.updatedAt,
      readonly: entry.readonly,
      ...(entry.editable
        ? { editable: true as const, filetype: entry.filetype, schemaType: entry.schemaType }
        : { editable: false as const, fileType: entry.fileType, mimeType: entry.mimeType }),
    };
    children.push(file);
  }
  return {
    kind: "dir",
    name,
    path,
    uri,
    readonly: entries.length > 0 ? entries.every((entry) => entry.readonly) : false,
    children: sortTree(children),
  };
}

export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  const projectId = getRouterParam(event, "projectId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  const query = getQuery(event);
  const workId = typeof query.workId === "string" ? query.workId : null;

  await requireProjectOwner({ projects: app.projectRepo }, projectId, user.userId);
  if (WORK_SCOPED_BROWSE_SCHEMES.has(scheme) && !workId) {
    throw createError({ statusCode: 400, message: "`workId` is required" });
  }

  const port = await contextPortForProjectBrowse({
    deps: { contextPorts: app.contextPorts, works: app.workRepo },
    projectId,
    userId: user.userId,
    workId,
  });
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });

  const root = rootUri(scheme, workId);
  const tree = await buildDirectory(port, root, root, ROOT_NAMES[scheme]);
  return serializeTransport({ projectId, scheme, tree } satisfies ProjectContextTreeResponse);
});
