import type { ContextReadResponse, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import type { ContextError, ContextPortFactory } from "../domains/context/index.js";
import { type EventSink, emitEvent } from "../domains/observability/index.js";
import { type ProjectRepository, requireProjectOwner } from "../domains/projects/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../domains/storage/index.js";

export interface ContextReadRouteDeps {
  projectRepo: ProjectRepository;
  contextPorts: ContextPortFactory;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
}
export interface ContextReadRouteInput {
  projectId: string;
  userId: string;
  scheme: ProjectContextTreeScheme;
  rawPath: unknown;
}
interface ResolvedReadPath {
  uri: string;
  path: string;
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

function normalizeSchemePath(scheme: ProjectContextTreeScheme, path: string): string {
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes(".."))
    throw createError({ statusCode: 400, message: '`path` may not contain ".."' });
  return segments.length > 0 ? `${scheme}://${segments.join("/")}` : `${scheme}://`;
}

export function resolveContextReadPath(
  scheme: ProjectContextTreeScheme,
  rawPath: unknown,
): ResolvedReadPath {
  if (Array.isArray(rawPath))
    throw createError({ statusCode: 400, message: "`path` must be a single string" });
  if (typeof rawPath !== "string" || rawPath.trim() === "")
    throw createError({ statusCode: 400, message: "`path` is required" });
  const trimmed = rawPath.trim();
  const explicitScheme = trimmed.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
  let uri: string;
  if (explicitScheme) {
    if (explicitScheme[1] !== scheme)
      throw createError({ statusCode: 400, message: "Context path scheme does not match route" });
    uri = normalizeSchemePath(scheme, explicitScheme[2]);
  } else if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) {
    throw createError({ statusCode: 400, message: 'Malformed URI: expected "scheme://path"' });
  } else {
    uri = normalizeSchemePath(scheme, trimmed);
  }
  const normalizedPath = uri.slice(`${scheme}://`.length);
  const segments = normalizedPath.split("/").filter(Boolean);
  if (!segments.at(-1))
    throw createError({ statusCode: 400, message: "`path` must name a non-root file" });
  return { uri, path: `/${segments.join("/")}` };
}

export async function handleContextReadRequest(
  deps: ContextReadRouteDeps,
  input: ContextReadRouteInput,
): Promise<ContextReadResponse> {
  await requireProjectOwner({ projects: deps.projectRepo }, input.projectId, input.userId);
  const path = resolveContextReadPath(input.scheme, input.rawPath);
  const port = deps.contextPorts.forProject(input.projectId, input.userId);
  const ref = await port.stat(path.uri);
  if (!ref.ok) contextErrorToHttp(ref.error);
  if (ref.value.kind === "tracked") {
    const read = await port.read(path.uri);
    if (!read.ok) contextErrorToHttp(read.error);
    return {
      kind: "tracked",
      path: path.path,
      content: read.value.content,
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
        uri: path.uri,
        storageKey: key,
        error: signed.error,
      },
    });
    if (signed.error.code === "not_found")
      throw createError({ statusCode: 404, message: "Context path not found" });
    throw createError({ statusCode: 502, message: "Failed to resolve context file URL" });
  }
  return {
    kind: "binary",
    path: path.path,
    url: signed.value,
    fileType: ref.value.fileType,
    mimeType: ref.value.mimeType ?? "application/octet-stream",
  };
}
