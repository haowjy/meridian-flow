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
 * Durable Work identity asserted by a scoped catalog or checked command constructor.
 * The type preserves the pair; only a known project snapshot can establish which
 * row is No Work. Use resourceWorkAuthorityFor when constructing writer commands.
 */
export type ResourceWorkAuthority =
  | { workId: null; workSlug?: undefined }
  | { workId: string; workSlug: string | null };
export type ResourceLocation = Readonly<
  { scheme: ProjectContextTreeScheme; path: string; name: string } & ResourceWorkAuthority
>;
/** A location's Work authority alone, without its other fields. */
export function workAuthorityOf(location: ResourceWorkAuthority): ResourceWorkAuthority {
  return location.workId === null
    ? { workId: null }
    : { workId: location.workId, workSlug: location.workSlug };
}
/** Where `setLocation` places a document: a folder path in place of the full path. */
export type ResourceDestination = Readonly<
  { scheme: ProjectContextTreeScheme; folderPath: string; name: string } & ResourceWorkAuthority
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
      body: MoveContextEntryRequest;
    }
  | {
      kind: "delete";
      scheme: ProjectContextTreeScheme;
      workId: string | null;
      workSlug: string | null;
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
