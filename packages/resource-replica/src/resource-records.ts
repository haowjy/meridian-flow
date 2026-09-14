/** Durable resource identity and namespace work; independent of storage and content transport. */
import type {
  CatalogEntry,
  CatalogScope,
  ContextOperationReceipt,
  CreateUntitledContextDocumentRequest,
  CreateUntitledContextDocumentResult,
  DeleteContextEntryRequest,
  MoveContextEntryRequest,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "./catalog";

/** Account-global identity. Project access belongs to catalogs and namespace intentions. */
export type ResourceKey = Readonly<{ handle: string }>;
export type ResourceLocation = Readonly<{
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  workId: string | null;
  /** Required with a Work ID before a durable command can validate canonical URI authority. */
  workSlug?: string;
}>;

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
  canonical: ResourceLocation | null;
  lifecycle:
    | { kind: "local" }
    | { kind: "acknowledged"; availabilityGeneration: string | null }
    | { kind: "terminal"; generation: string; transitionId: string };
  aliases: Record<
    string,
    { publicationObligationId: string; introducedAtIdentityRevision: number }
  >;
  obligations: {
    canonicalSync?: { obligationId: string; documentId: string; adoptionRevision: number };
    canonicalRefresh?: {
      operationId: string;
      identityRevision: number;
    };
    publication?: { obligationId: string; documentId: string; adoptionRevision: number };
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
      : {
          kind: "operation";
          receipt: Extract<ContextOperationReceipt, { command: { kind: Kind } }>;
        };
  };
}[NamespaceRequest["kind"]];

export type NamespaceIntent = ResourceKey & {
  projectId: string;
  intentId: string;
  sequence: number;
  identityRevision: number;
  desired:
    | { kind: "create"; folderPath: string }
    | { kind: "set-location"; destination: Omit<ResourceLocation, "path"> & { folderPath: string } }
    | { kind: "delete" };
  attempts: readonly NamespaceAttempt[];
  state:
    | "pending"
    | "submitted"
    | "received"
    | "settled"
    | "needs-repair"
    | "cancelled"
    | "settled-locally";
};

export type ResourceRecord = {
  resource: ResourceDescriptor;
  intents: readonly NamespaceIntent[];
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
  | { kind: "operation"; receipt: ContextOperationReceipt };

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
