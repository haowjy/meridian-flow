/** Validated transport boundary for exact-ID project availability lookup. */
import {
  assertAvailabilityGeneration,
  type ProjectContextFolderResolution,
  type ProjectContextIdentityLookupResult,
  type ProjectContextIdentityResolution,
} from "@meridian/contracts/protocol";
import { getProjectContextAvailability } from "@/client/api/projects-api";

function malformed(): never {
  throw new TypeError("Malformed project availability response");
}

function validateResolution(value: unknown): ProjectContextIdentityResolution {
  if (!value || typeof value !== "object") return malformed();
  const resolution = value as Record<string, unknown>;
  if (typeof resolution.documentId !== "string" || typeof resolution.kind !== "string") {
    return malformed();
  }
  const generation =
    resolution.kind === "not-visible" || resolution.kind === "indeterminate"
      ? resolution.checkedGeneration
      : resolution.generation;
  if (typeof generation !== "string") return malformed();
  try {
    assertAvailabilityGeneration(generation);
  } catch {
    return malformed();
  }
  switch (resolution.kind) {
    case "available":
      if (!resolution.entry || !resolution.authority) return malformed();
      break;
    case "deleted":
      if (!resolution.lastAuthority) return malformed();
      break;
    case "authority-unavailable":
      if (!resolution.authority || typeof resolution.reason !== "string") return malformed();
      break;
    case "not-visible":
      break;
    case "indeterminate":
      if (resolution.reason !== "identity_inconsistent") return malformed();
      break;
    default:
      return malformed();
  }
  return resolution as unknown as ProjectContextIdentityResolution;
}

export function validateProjectContextAvailabilityResult(
  projectId: string,
  requestedDocumentIds: readonly string[],
  value: unknown,
  requestedFolderIds?: readonly string[],
): ProjectContextIdentityLookupResult {
  if (!value || typeof value !== "object") return malformed();
  const result = value as Record<string, unknown>;
  if (
    result.projectId !== projectId ||
    typeof result.resolutionId !== "string" ||
    !Array.isArray(result.resolutions)
  ) {
    return malformed();
  }
  const requested = [...new Set(requestedDocumentIds)];
  const resolutions = result.resolutions.map(validateResolution);
  const returned = resolutions.map((resolution) => resolution.documentId);
  if (
    returned.length !== requested.length ||
    new Set(returned).size !== returned.length ||
    returned.some((documentId) => !requested.includes(documentId))
  ) {
    return malformed();
  }
  const byId = new Map(resolutions.map((resolution) => [resolution.documentId, resolution]));
  return {
    projectId,
    resolutionId: result.resolutionId,
    resolutions: requested.map(
      (documentId) => byId.get(documentId) as ProjectContextIdentityResolution,
    ),
    ...(requestedFolderIds
      ? {
          folderResolutions: validateFolderResolutions(
            requestedFolderIds,
            result.folderResolutions,
          ),
        }
      : {}),
  };
}

/** One answer per requested folder, each about that folder: the same rule documents follow. */
function validateFolderResolutions(
  requestedFolderIds: readonly string[],
  value: unknown,
): ProjectContextFolderResolution[] {
  if (!Array.isArray(value)) return malformed();
  const requested = [...new Set(requestedFolderIds)];
  const byId = new Map<string, ProjectContextFolderResolution>();
  for (const raw of value) {
    const resolution = validateFolderResolution(raw);
    if (!requested.includes(resolution.folderId) || byId.has(resolution.folderId))
      return malformed();
    byId.set(resolution.folderId, resolution);
  }
  if (byId.size !== requested.length) return malformed();
  return requested.map((folderId) => byId.get(folderId) as ProjectContextFolderResolution);
}

function validateFolderResolution(value: unknown): ProjectContextFolderResolution {
  if (!value || typeof value !== "object") return malformed();
  const resolution = value as ProjectContextFolderResolution;
  if (typeof resolution.folderId !== "string") return malformed();
  try {
    switch (resolution.kind) {
      case "available":
        if (resolution.entry?.kind !== "folder" || resolution.entry.entryId !== resolution.folderId)
          return malformed();
        assertAvailabilityGeneration(resolution.generation);
        return resolution;
      case "deleted":
        assertAvailabilityGeneration(resolution.generation);
        return resolution;
      case "not-visible":
      case "indeterminate":
      case "authority-unavailable":
        assertAvailabilityGeneration(resolution.checkedGeneration);
        return resolution;
      default:
        return malformed();
    }
  } catch {
    return malformed();
  }
}

export async function lookupProjectContextAvailability(
  projectId: string,
  documentIds: readonly string[],
  signal?: AbortSignal,
  folderIds?: readonly string[],
): Promise<ProjectContextIdentityLookupResult> {
  const requested = [...new Set(documentIds)];
  const folders = folderIds?.length ? [...new Set(folderIds)] : undefined;
  return validateProjectContextAvailabilityResult(
    projectId,
    requested,
    await getProjectContextAvailability(projectId, requested, signal, folders),
    folders,
  );
}
