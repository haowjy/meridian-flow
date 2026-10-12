/** Project-final stable-document availability protocol. */
import type { DocumentId, ProjectId, UserId, WorkId } from "../ids.js";
import type { WorkSlug } from "../works/work-slug.js";
import type { CatalogFileEntry } from "./context-catalog.js";

export type AvailabilityGeneration = string;

const CANONICAL_AVAILABILITY_GENERATION = /^(0|[1-9]\d*)$/;

/** Validate the one wire/storage spelling accepted for availability generations. */
export function assertAvailabilityGeneration(
  value: string,
): asserts value is AvailabilityGeneration {
  if (!CANONICAL_AVAILABILITY_GENERATION.test(value)) {
    throw new TypeError(`Invalid availability generation: ${JSON.stringify(value)}`);
  }
}

/** Stable identifier derived by the availability coordinator for one revocation command. */
export type AvailabilityCommandId = string;

/** The authenticated user is the account boundary for browser session authority. */
export type AccountId = UserId;

export type LiveDocumentSessionLease = {
  accountId: AccountId;
  projectId: ProjectId;
  documentId: DocumentId;
  generation: AvailabilityGeneration;
};

export type DocumentFenceKey = `document/${AccountId}/${DocumentId}`;
export type AccessFenceKey = `access/${AccountId}/${ProjectId}/${DocumentId}`;

export type RevocationFence = {
  revokedThrough: AvailabilityGeneration;
  commandId: AvailabilityCommandId;
};

export interface LiveDocumentSessionAuthority {
  admit(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
  ): Promise<LiveDocumentSessionLease>;
  revokeDocument(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{ revokedThrough: AvailabilityGeneration; persistence: "cleared" }>;
  revokeAccess(
    projectId: ProjectId,
    documentId: DocumentId,
    generation: AvailabilityGeneration,
    commandId: AvailabilityCommandId,
  ): Promise<{
    revokedThrough: AvailabilityGeneration;
    persistence: "cleared" | "retained-by-other-lease";
  }>;
}

export type ProjectContextIdentityLookupRequest = {
  projectId: ProjectId;
  documentIds: readonly DocumentId[];
  folderIds?: readonly string[];
};

export type ProjectContextAuthority =
  | { kind: "project"; projectId: ProjectId }
  | { kind: "user"; userId: UserId }
  | { kind: "work"; projectId: ProjectId; workId: WorkId; workSlug: WorkSlug | null }
  | { kind: "lineage"; projectId: ProjectId; rootThreadId: string; rootThreadRef: string };

export type ProjectContextIdentityResolution =
  | {
      kind: "available";
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      entry: CatalogFileEntry;
    }
  | {
      kind: "deleted";
      observationVersion: string;
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      lastAuthority: ProjectContextAuthority;
    }
  | {
      kind: "authority-unavailable";
      documentId: DocumentId;
      generation: AvailabilityGeneration;
      authority: ProjectContextAuthority;
      reason: "work_deleted" | "project_deleted" | "lineage_hidden";
    }
  | {
      kind: "not-visible";
      documentId: DocumentId;
      checkedGeneration: AvailabilityGeneration;
    }
  | {
      kind: "indeterminate";
      documentId: DocumentId;
      checkedGeneration: AvailabilityGeneration;
      reason: "identity_inconsistent";
    };

/** Exact folder identity evidence; scoped catalog absence is deliberately not a tombstone. */
export type ProjectContextFolderResolution = { folderId: string } & (
  | {
      kind: "available";
      entry: import("./context-catalog.js").CatalogFolderEntry;
      generation: AvailabilityGeneration;
    }
  | { kind: "deleted"; generation: AvailabilityGeneration; observationVersion: string }
  | {
      kind: "not-visible" | "indeterminate" | "authority-unavailable";
      checkedGeneration: AvailabilityGeneration;
    }
);

export type ProjectContextIdentityLookupResult = {
  projectId: ProjectId;
  resolutionId: string;
  resolutions: readonly ProjectContextIdentityResolution[];
  folderResolutions?: readonly ProjectContextFolderResolution[];
};

export const PROJECT_CONTEXT_AVAILABILITY_MAX_IDS = 128;

/** Owner-scoped browser address lookup; aliases never redirect through another alias. */
export type DocumentAddressResult =
  | {
      kind: "current" | "alias";
      document: Extract<ProjectContextIdentityResolution, { kind: "available" }>;
    }
  | { kind: "unavailable" };
