/** Durable resource identity and namespace work; independent of storage and content transport. */
import type {
  CatalogEntry,
  CatalogFileClassification,
  CatalogScope,
  ContextOperationReceipt,
  CreateUntitledContextDocumentRequest,
  CreateUntitledContextDocumentResult,
  DeleteContextEntryRequest,
  MeridianError,
  MoveContextEntryRequest,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "./catalog";

/** Account-global identity. Project access belongs to catalogs and namespace intentions. */
export type ResourceKey = Readonly<{ handle: string }>;
/**
 * Durable owner identity asserted by a scoped catalog or checked command constructor.
 * Project-scoped schemes have no owner (`workId: null`). A Work-scoped location
 * names a Work (id and slug, slug null for No Work) or, for Scratch, a lineage
 * (the first chat's id and its handle, as in `scratch://@/c12/`). The type
 * preserves each pair; only a known project snapshot can establish which row is
 * No Work. Use resourceWorkAuthorityFor when constructing writer commands.
 */
export type ResourceOwner =
  | { workId: null; workSlug?: undefined; rootThreadId?: undefined; rootThreadRef?: undefined }
  | { workId: string; workSlug: string | null; rootThreadId?: undefined; rootThreadRef?: undefined }
  | { workId: null; workSlug?: undefined; rootThreadId: string; rootThreadRef: string };
export type ResourceLocation = Readonly<
  { scheme: ProjectContextTreeScheme; path: string; name: string } & ResourceOwner
>;
/** A location's owner alone, without its other fields. */
export function ownerOf(location: ResourceOwner): ResourceOwner {
  if (location.rootThreadId !== undefined)
    return {
      workId: null,
      rootThreadId: location.rootThreadId,
      rootThreadRef: location.rootThreadRef,
    };
  return location.workId === null
    ? { workId: null }
    : { workId: location.workId, workSlug: location.workSlug };
}
/** What decides whether two owners are the same: the Work, or the lineage. Handles and slugs follow. */
export type ResourceOwnerKey = {
  workId: string | null;
  workSlug?: string | null;
  rootThreadId?: string | null;
};
/** Whether two locations are held by the same owner. */
export function sameOwner(left: ResourceOwnerKey, right: ResourceOwnerKey): boolean {
  return (
    left.workId === right.workId &&
    (left.workSlug ?? null) === (right.workSlug ?? null) &&
    (left.rootThreadId ?? null) === (right.rootThreadId ?? null)
  );
}
/** Where `setLocation` places a document: a folder path in place of the full path. */
export type ResourceDestination = Readonly<
  { scheme: ProjectContextTreeScheme; folderPath: string; name: string } & ResourceOwner
>;

export type ResourceDescriptor = ResourceKey & {
  revision: number;
  identity: { documentId: string; revision: number };
  content:
    | {
        kind: "exact";
        databaseName: string;
        schema: string | null;
        /** One new reservation may establish its initialization marker before first exposure. */
        initialization?: "reserved";
      }
    | { kind: "unacquired" };
  /** Stable editor/viewer classification retained when no catalog checkpoint is available. */
  classification: CatalogFileClassification;
  canonical: ResourceLocation | null;
  lifecycle:
    | { kind: "local" }
    | { kind: "acknowledged"; availabilityGeneration: string | null }
    | { kind: "terminal"; generation: string; transitionId: string };
  aliases: Record<string, { introducedAtIdentityRevision: number }>;
  obligations: {
    /** A new local document cannot dispatch Create until content exists or the writer files it. */
    createEligibility?: { eligibleAt: number | null };
    canonicalRefresh?: {
      operationId: string;
      identityRevision: number;
    };
    sessionAdoption?: {
      transitionId: string;
      projectId: string;
      documentId: string;
      identityRevision: number;
      exactDatabaseName: string;
      generation: string | null;
    };
    cleanup?: { obligationId: string; exactDatabaseName: string };
  };
};

/** The endpoint's authority is part of the submitted request, not inferred from current UI state. */
export type NamespaceRequest =
  | { kind: "create"; body: CreateUntitledContextDocumentRequest }
  | {
      kind: "move";
      scheme: ProjectContextTreeScheme;
      sourceWorkSlug: string | null;
      destinationWorkSlug: string | null;
      /** Handles of the lineages named by the body's root thread ids; they identify receipt URIs. */
      sourceRootThreadRef?: string | null;
      destinationRootThreadRef?: string | null;
      body: MoveContextEntryRequest;
    }
  | {
      kind: "delete";
      scheme: ProjectContextTreeScheme;
      workId: string | null;
      workSlug: string | null;
      rootThreadId?: string | null;
      rootThreadRef?: string | null;
      body: DeleteContextEntryRequest;
    };

export type NamespaceAttempt = {
  [Kind in NamespaceRequest["kind"]]: {
    attemptId: string;
    request: Extract<NamespaceRequest, { kind: Kind }>;
    outcome?: Kind extends "create"
      ? Extract<NamespaceOutcome, { kind: "create" }>
      :
          | Extract<NamespaceOutcome, { kind: "refusal" }>
          | {
              kind: "operation";
              receipt: Extract<ContextOperationReceipt, { command: { kind: Kind } }>;
            };
  };
}[NamespaceRequest["kind"]];

export type NamespaceIntent = ResourceKey & {
  projectId: string;
  intentId: string;
  /** Caller-issued id lets surfaces correlate settlement before background dispatch. */
  operationId?: string;
  sequence: number;
  identityRevision: number;
  desired:
    | { kind: "create"; folderPath: string; provisionalName?: string }
    | {
        kind: "set-location";
        destination: ResourceDestination;
      }
    | { kind: "set-folder-location"; destination: ResourceDestination }
    | { kind: "delete" };
  attempts: readonly NamespaceAttempt[];
  /** Local receipt application time; immutable evidence is retained after the UI note expires. */
  settledAt?: number;
  state:
    | "pending"
    | "submitted"
    | "received"
    | "settled"
    | "superseded"
    | "needs-repair"
    | "cancelled"
    | "settled-locally";
};

export type ResourceRecord = {
  resource: ResourceDescriptor;
  intents: readonly NamespaceIntent[];
};

/** A folder is namespace identity only: it never owns a document id, content or classification. */
export type FolderNamespaceRecord = ResourceKey & {
  /** Null for account-owned personal folders; command projects live on the intents. */
  projectId: string | null;
  folderId: string;
  revision: number;
  canonical: ResourceLocation;
  canonicalRefresh?: { operationId: string };
  intents: readonly NamespaceIntent[];
};

export type FolderNamespaceWrite = {
  expectedRevision: number | null;
  next: FolderNamespaceRecord;
};

/** Persist only checkpoint data; indexes are derived by the catalog reducer. */
export type ResourceCatalogCheckpoint = Pick<
  CatalogCacheView,
  "scope" | "generation" | "appliedRevision" | "observedHeadRevision" | "cursor"
> & {
  /** Project whose resource projection was installed with this catalog checkpoint. */
  projectId: string;
  revision: number;
  entries: readonly CatalogEntry[];
  invalidatedEntryIds: readonly string[];
};

export type ResourceWrite = {
  expectedRevision: number | null;
  next: ResourceRecord;
};

export type MetadataCommitResult = "committed" | "stale";
export type ResourceProjectionSnapshot = {
  records: readonly ResourceRecord[];
  folders: readonly FolderNamespaceRecord[];
  catalogs: readonly ResourceCatalogCheckpoint[];
};

/** All mutation results mean outer commit. Network, locks and Yjs work stay outside these calls. */
export interface ResourceMetadataStore {
  readonly accountId: string;
  readResource(key: ResourceKey): Promise<ResourceRecord | null>;
  /** Reads one resource only when this project's intents or catalog expose it. */
  readAccessibleResource(projectId: string, key: ResourceKey): Promise<ResourceRecord | null>;
  readProjection(projectId: string): Promise<ResourceProjectionSnapshot>;
  commitResource(write: ResourceWrite): Promise<MetadataCommitResult>;
  readCatalog(projectId: string, scope: CatalogScope): Promise<ResourceCatalogCheckpoint | null>;
  commitCatalog(input: {
    expectedRevision: number | null;
    next: ResourceCatalogCheckpoint;
    resources: readonly ResourceWrite[];
    /** Folder canonical observations commit with the checkpoint that proves them. */
    folders: readonly FolderNamespaceWrite[];
  }): Promise<MetadataCommitResult>;
  observeProjection(
    projectId: string,
    listener: (snapshot: ResourceProjectionSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void;
  beginClose(): void;
  finishClose(): Promise<void>;
}

/** Transport evidence is matched to its recorded attempt by journal policy before installation. */
export type NamespaceOutcome =
  | { kind: "create"; result: CreateUntitledContextDocumentResult }
  | { kind: "operation"; receipt: ContextOperationReceipt }
  | { kind: "refusal"; operationId: string; error: MeridianError };

/** The caller persists the immutable attempt before submit and retains uncertainty on failure. */
export interface ResourceNamespaceTransport {
  readonly accountId: string;
  readOutcome(projectId: string, request: NamespaceRequest): Promise<NamespaceOutcome | null>;
  submit(projectId: string, request: NamespaceRequest): Promise<NamespaceOutcome | null>;
}

export type ResourceNamespaceLockResult<T> = { kind: "acquired"; value: T } | { kind: "busy" };

/** Every identity/terminal transition shares this short resource lock with namespace dispatch. */
export interface ResourceNamespaceLock {
  readonly accountId: string;
  run<T>(key: ResourceKey, task: () => Promise<T>): Promise<ResourceNamespaceLockResult<T>>;
}
