import {
  serializeTransport,
  type WorkbenchContextTreeDirectory,
  type WorkbenchContextTreeFile,
  type WorkbenchContextTreeNode,
  type WorkbenchContextTreeResponse,
  type WorkbenchContextTreeScheme,
} from "@meridian/contracts/protocol";
import { createError, defineEventHandler, getRouterParam } from "nitro/h3";
import type { ContextError, FileEntry } from "../../../../../../domains/context/index.js";
import type { ContextPort } from "../../../../../../domains/context/ports/context-port.js";
import { requireWorkbenchOwner } from "../../../../../../domains/workbenches/index.js";
import { requireAppUser } from "../../../../../../lib/auth-gate.js";

const ROOT_NAMES: Record<WorkbenchContextTreeScheme, string> = {
  kb: "Knowledge Base",
  work: "Work",
  user: "User Files",
  fs1: "Workbench Files",
};
function parseScheme(value: string): WorkbenchContextTreeScheme {
  if (value === "kb" || value === "work" || value === "user" || value === "fs1") return value;
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
    case "context_unavailable":
      throw createError({ statusCode: 503, message: "Context is unavailable" });
    case "io_error":
      throw createError({ statusCode: 502, message: error.message });
  }
}
function pathFromUri(scheme: WorkbenchContextTreeScheme, uri: string): string {
  const prefix = `${scheme}://`;
  if (!uri.startsWith(prefix))
    throw createError({ statusCode: 502, message: `Unexpected context URI: ${uri}` });
  const path = uri.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  return path ? `/${path}` : "/";
}
function nameFromPath(path: string): string {
  if (path === "/") return "";
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}
function sortTree(nodes: WorkbenchContextTreeNode[]): WorkbenchContextTreeNode[] {
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
  scheme: WorkbenchContextTreeScheme,
  uri: string,
  name: string,
): Promise<WorkbenchContextTreeDirectory> {
  const path = pathFromUri(scheme, uri);
  const entries = await listEntries(port, uri);
  const children: WorkbenchContextTreeNode[] = [];
  for (const entry of entries) {
    const entryPath = pathFromUri(scheme, entry.uri);
    if (entry.kind === "directory") {
      children.push(await buildDirectory(port, scheme, entry.uri, nameFromPath(entryPath)));
      continue;
    }
    if (!entry.documentId)
      throw createError({
        statusCode: 502,
        message: `Context file is missing persisted document id: ${entry.uri}`,
      });
    const file: WorkbenchContextTreeFile = {
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
  const workbenchId = getRouterParam(event, "workbenchId") ?? "";
  const scheme = parseScheme(getRouterParam(event, "scheme") ?? "");
  await requireWorkbenchOwner({ workbenches: app.workbenchRepo }, workbenchId, user.userId);
  const tree = await buildDirectory(
    app.contextPorts.forWorkbench(workbenchId, user.userId),
    scheme,
    `${scheme}://`,
    ROOT_NAMES[scheme],
  );
  return serializeTransport({ workbenchId, scheme, tree } satisfies WorkbenchContextTreeResponse);
});
