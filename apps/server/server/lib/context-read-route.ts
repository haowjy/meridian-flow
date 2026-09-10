import {
  type CanonicalContextAuthority,
  parseUnifiedContextUri,
} from "@meridian/contracts/context-uri";
import type { ContextReadResponse, ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { createError } from "nitro/h3";
import {
  isWorkScopedBrowseScheme,
  projectBrowseContextUri,
  workScopedBrowseUri,
} from "../domains/context/browse-layer-scheme.js";
import {
  contextPortForProjectBrowse,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";
import { type EventSink, emitEvent } from "../domains/observability/index.js";
import {
  type ProjectRepository,
  type ProjectWorkAuthorityResolver,
  requireProjectOwner,
  type WorkRepository,
} from "../domains/projects/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../domains/storage/index.js";
import { contextErrorToHttp } from "./context-error-http.js";

export interface ContextReadRouteDeps {
  projectRepo: ProjectRepository;
  workRepo: WorkRepository;
  contextPorts: UnifiedContextPortFactory;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
  workAuthorityResolver: ProjectWorkAuthorityResolver;
}
export interface ContextReadRouteInput {
  projectId: string;
  userId: string;
  scheme: ProjectContextTreeScheme;
  rawPath: unknown;
  workId?: string | null;
}
interface ResolvedReadPath {
  uri: string;
  path: string;
}

function normalizeSchemePath(scheme: ProjectContextTreeScheme, path: string): string {
  const segments = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes(".."))
    throw createError({ statusCode: 400, message: '`path` may not contain ".."' });
  return projectBrowseContextUri(scheme, segments.join("/"));
}

export function resolveContextReadPath(
  scheme: ProjectContextTreeScheme,
  rawPath: unknown,
  authority: CanonicalContextAuthority = { kind: "contextual" },
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
    const parsed = parseUnifiedContextUri(trimmed);
    if (!parsed.ok) throw createError({ statusCode: 400, message: parsed.error.reason });
    if (isWorkScopedBrowseScheme(scheme)) {
      if (authority.kind === "contextual")
        throw createError({ statusCode: 500, message: "Missing resolved context authority" });
      if (parsed.value.authority.kind === "contextual") {
        uri = workScopedBrowseUri(scheme, authority, parsed.value.path);
      } else {
        const sameAuthority =
          parsed.value.authority.kind === authority.kind &&
          (authority.kind !== "work" ||
            (parsed.value.authority.kind === "work" &&
              parsed.value.authority.workSlug === authority.workSlug));
        if (!sameAuthority) {
          throw createError({ statusCode: 400, message: "Context authority does not match route" });
        }
        uri = workScopedBrowseUri(scheme, authority, parsed.value.path);
      }
    } else uri = parsed.value.normalized;
  } else if (/^[a-z][a-z0-9+.-]*:/.test(trimmed)) {
    throw createError({ statusCode: 400, message: 'Malformed URI: expected "scheme://path"' });
  } else if (isWorkScopedBrowseScheme(scheme)) {
    if (authority.kind === "contextual") {
      throw createError({ statusCode: 500, message: "Missing resolved context authority" });
    }
    uri = workScopedBrowseUri(scheme, authority, trimmed);
  } else {
    uri = normalizeSchemePath(scheme, trimmed);
  }
  const prefix = `${scheme}://`;
  const normalizedPath = uri.slice(prefix.length);
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
  let authority: CanonicalContextAuthority = { kind: "contextual" };
  if (isWorkScopedBrowseScheme(input.scheme)) {
    if (!input.workId) authority = { kind: "none" };
    else {
      const resolved = await deps.workAuthorityResolver.byId(input.projectId, input.workId);
      if (!resolved) {
        throw createError({ statusCode: 404, message: "Work not found" });
      }
      authority = resolved;
    }
  }
  const path = resolveContextReadPath(input.scheme, input.rawPath, authority);
  const port = await contextPortForProjectBrowse({
    deps: {
      contextPorts: deps.contextPorts,
      works: deps.workRepo,
      workAuthorityResolver: deps.workAuthorityResolver,
    },
    projectId: input.projectId,
    userId: input.userId,
    workId: input.workId,
  });
  if (!port) throw createError({ statusCode: 404, message: "Work not found" });
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
