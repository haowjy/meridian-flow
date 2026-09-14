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

export type ResourceKey = Readonly<{ projectId: string; handle: string }>;
export type ResourceLocation = Readonly<{
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  workId: string | null;
}>;

export type ResourceDescriptor = ResourceKey & {
  revision: number;
  identity: { documentId: string; revision: number };
  content: { kind: "exact"; databaseName: string; schema: string | null } | { kind: "unacquired" };
  recovery?: { sourceKey: string };
  canonical: ResourceLocation | null;
  lifecycle:
    | { kind: "recovering" }
    | { kind: "local" }
    | { kind: "acknowledged"; availabilityGeneration: string | null }
    | { kind: "terminal"; generation: string; transitionId: string };
  aliases: Record<
    string,
    { publicationObligationId: string; introducedAtIdentityRevision: number }
  >;
  obligations: {
    canonicalSync?: { obligationId: string; documentId: string; adoptionRevision: number };
    publication?: { obligationId: string; documentId: string; adoptionRevision: number };
    cleanup?: { obligationId: string; exactDatabaseName: string };
  };
};

/** The endpoint's authority is part of the submitted request, not inferred from current UI state. */
export type NamespaceRequest =
  | { kind: "create"; body: CreateUntitledContextDocumentRequest }
  | { kind: "move"; scheme: ProjectContextTreeScheme; body: MoveContextEntryRequest }
  | {
      kind: "delete";
      scheme: ProjectContextTreeScheme;
      workId: string | null;
      body: DeleteContextEntryRequest;
    };

export type NamespaceAttempt = {
  [Kind in NamespaceRequest["kind"]]: {
    attemptId: string;
    request: Extract<NamespaceRequest, { kind: Kind }>;
    outcome?: Kind extends "create"
      ? { kind: "create"; result: CreateUntitledContextDocumentResult }
      : {
          kind: "operation";
          receipt: Extract<ContextOperationReceipt, { command: { kind: Kind } }>;
        };
  };
}[NamespaceRequest["kind"]];

export type NamespaceIntent = ResourceKey & {
  intentId: string;
  sequence: number;
  identityRevision: number;
  desired:
    | { kind: "create"; folderPath: string }
    | { kind: "set-location"; destination: Omit<ResourceLocation, "path"> & { folderPath: string } }
    | { kind: "delete" };
  attempts: readonly NamespaceAttempt[];
  state: "pending" | "submitted" | "settled" | "needs-repair" | "cancelled" | "settled-locally";
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
  revision: number;
  entries: readonly CatalogEntry[];
  invalidatedEntryIds: readonly string[];
};

export type MigrationEvidence = {
  sourceKey: string;
  raw: string;
  status: "imported" | "recovery";
  reason?: string;
};

export type ResourceMigrationCheckpoint = {
  revision: number;
  state: "importing" | "complete";
};

export type ResourceWrite = {
  expectedRevision: number | null;
  next: ResourceRecord;
};

export type MetadataCommitResult = "committed" | "stale";
export type ProjectResourceSnapshot = {
  records: readonly ResourceRecord[];
  catalogs: readonly ResourceCatalogCheckpoint[];
};

/** All mutation results mean outer commit. Network, locks and Yjs work stay outside these calls. */
export interface ResourceMetadataStore {
  readonly accountId: string;
  readResource(key: ResourceKey): Promise<ResourceRecord | null>;
  commitResource(write: ResourceWrite): Promise<MetadataCommitResult>;
  readCatalog(scope: CatalogScope): Promise<ResourceCatalogCheckpoint | null>;
  commitCatalog(input: {
    expectedRevision: number | null;
    next: ResourceCatalogCheckpoint;
    resources: readonly ResourceWrite[];
  }): Promise<MetadataCommitResult>;
  readMigration(): Promise<{
    checkpoint: ResourceMigrationCheckpoint | null;
    evidence: readonly MigrationEvidence[];
  }>;
  commitMigration(input: {
    expectedRevision: number | null;
    next: ResourceMigrationCheckpoint;
    evidence: readonly MigrationEvidence[];
    resources: readonly ResourceWrite[];
  }): Promise<MetadataCommitResult>;
  resolveMigrationEvidence(input: {
    sourceKey: string;
    expectedRaw: string;
    resource: ResourceWrite;
  }): Promise<MetadataCommitResult>;
  observeProject(
    projectId: string,
    listener: (snapshot: ProjectResourceSnapshot) => void,
    onError: (error: unknown) => void,
  ): () => void;
  beginClose(): void;
  finishClose(): Promise<void>;
}
