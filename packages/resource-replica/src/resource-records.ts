/** Durable resource identity and namespace work; independent of storage and content transport. */
import type {
  CatalogEntry,
  CatalogFileClassification,
  CatalogScope,
  ContextOperationReceipt,
  ContextParentOrderPolicy,
  ContextSiblingPosition,
  CreateUntitledContextDocumentAnswer,
  CreateUntitledContextDocumentRequest,
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
 * names a Work (id and handle, handle null for No Work) or, for Scratch, a lineage
 * (the first chat's id and its handle, as in `scratch://@c12/`); uploads are held by a chat
 * (its id and handle, as in `uploads://@c15/`; no handle, and a bare `uploads://` URI, until the chat exists). The type
 * preserves each pair; only a known project snapshot can establish which row is
 * No Work. Use resourceWorkAuthorityFor when constructing writer commands.
 */
export type ResourceOwner =
  | ({ workId: null; workHandle?: undefined } & NoLineage & NoChat)
  | ({ workId: string; workHandle: string | null } & NoLineage & NoChat)
  | ({ workId: null; workHandle?: undefined; rootThreadId: string; rootThreadRef: string } & NoChat)
  | ({ workId: null; workHandle?: undefined; chatId: string; chatRef: string | null } & NoLineage);
type NoLineage = { rootThreadId?: undefined; rootThreadRef?: undefined };
type NoChat = { chatId?: undefined; chatRef?: undefined };
export type ResourceLocation = Readonly<
  { scheme: ProjectContextTreeScheme; path: string; name: string } & ResourceOwner
>;
/** A location's owner alone, without its other fields. */
export function ownerOf(location: ResourceOwner): ResourceOwner {
  if (location.chatId !== undefined)
    return { workId: null, chatId: location.chatId, chatRef: location.chatRef };
  if (location.rootThreadId !== undefined)
    return {
      workId: null,
      rootThreadId: location.rootThreadId,
      rootThreadRef: location.rootThreadRef,
    };
  return location.workId === null
    ? { workId: null }
    : { workId: location.workId, workHandle: location.workHandle };
}
/** What decides whether two owners are the same: the Work, or the lineage. Handles follow. */
export type ResourceOwnerKey = {
  workId: string | null;
  workHandle?: string | null;
  rootThreadId?: string | null;
  chatId?: string | null;
};
/** Whether two locations are held by the same owner. */
export function sameOwner(left: ResourceOwnerKey, right: ResourceOwnerKey): boolean {
  return (
    left.workId === right.workId &&
    (left.workHandle ?? null) === (right.workHandle ?? null) &&
    (left.rootThreadId ?? null) === (right.rootThreadId ?? null) &&
    (left.chatId ?? null) === (right.chatId ?? null)
  );
}
/** A picked folder identity or a qualified area's root. Paths are observations, not edges. */
export type ParentRef =
  | Readonly<{ kind: "folder"; folderId: string }>
  | Readonly<{ kind: "root"; scheme: ProjectContextTreeScheme; owner: ResourceOwner }>;
export type ResourceDestination = Readonly<{
  parent: ParentRef;
  createFolders?: string[];
  name: string;
  position?: ContextSiblingPosition;
}>;
export type DestinationParentLookup = (folderId: string) => ResourceLocation | null;

/** Resolve only canonical observations when preparing immutable transport evidence. */
export function destinationParentLocation(
  parent: ParentRef,
  lookup: DestinationParentLookup,
): ResourceLocation | null {
  return parent.kind === "folder"
    ? lookup(parent.folderId)
    : { scheme: parent.scheme, ...parent.owner, path: "", name: "" };
}

export function destinationLocation(
  destination: ResourceDestination,
  lookup: DestinationParentLookup,
): ResourceLocation | null {
  const parent = destinationParentLocation(destination.parent, lookup);
  return parent
    ? {
        ...parent,
        path: [
          parent.path.replace(/\/$/, ""),
          ...(destination.createFolders ?? []),
          destination.name,
        ].join("/"),
        name: destination.name.split("/").at(-1) ?? destination.name,
      }
    : null;
}

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
  /** Parent identity from the same canonical observation; absent until observed. */
  canonicalParent?: ParentRef;
  /** Sibling rank from the same canonical observation; meaningful when its parent is manual. */
  canonicalRank?: string | null;
  /** Per-entry namespace mutation revision from the same canonical observation. */
  canonicalLocationVersion?: string;
  /** Server namespace watermark of the canonical observation; absent for local identities. */
  observationVersion?: string;
  lifecycle:
    | { kind: "local" }
    | { kind: "acknowledged"; availabilityGeneration: string | null }
    | {
        kind: "terminal";
        generation: string;
        transitionId: string;
        /**
         * Server namespace version that proved the deletion. Only a strictly newer observation
         * of the document as present revives it; without one it never revives from a catalog.
         */
        deletionVersion?: string;
      };
  aliases: Record<string, { introducedAtIdentityRevision: number }>;
  /** The terminal transition a newer server observation superseded; its late purge is stale. */
  revivedFrom?: { generation: string; transitionId: string };
  obligations: {
    /** A new local document cannot dispatch Create until content exists or the writer files it. */
    createEligibility?: { eligibleAt: number | null };
    canonicalRefresh?: {
      operationId: string;
      identityRevision: number;
      observationVersion?: string;
    };
    sessionAdoption?: {
      transitionId: string;
      projectId: string;
      documentId: string;
      identityRevision: number;
      exactDatabaseName: string;
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
      sourceWorkHandle: string | null;
      destinationWorkHandle: string | null;
      /** Handles of the lineages named by the body's root thread ids; they identify receipt URIs. */
      sourceRootThreadRef?: string | null;
      destinationRootThreadRef?: string | null;
      body: MoveContextEntryRequest;
    }
  | {
      kind: "delete";
      scheme: ProjectContextTreeScheme;
      workId: string | null;
      workHandle: string | null;
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
  /** Account-local placement admission order; comparable across file and folder journals. */
  admissionOrder?: number;
  identityRevision: number;
  desired:
    | {
        kind: "create";
        folderPath: string;
        provisionalName?: string;
        /**
         * Where the writer put the document, sent with the create so the server can join a
         * branch's document waiting there. Absent for a nameless create (the editor's New document).
         */
        destination?: ResourceDestination;
      }
    | {
        kind: "set-location";
        /** Original input; canonical destination is only for display and comparison. */
        typedName: string;
        destination: ResourceDestination;
      }
    | {
        kind: "set-folder-location";
        /** Original input; canonical destination is only for display and comparison. */
        typedName: string;
        destination: ResourceDestination;
      }
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
    | "unexecutable-after-terminal"
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
  /** Parent identity installed atomically with the canonical location. */
  canonicalParent?: ParentRef;
  /** This folder's rank and child-order policy from the same canonical observation. */
  canonicalRank?: string | null;
  canonicalLocationVersion?: string;
  canonicalOrderPolicy?: ContextParentOrderPolicy;
  /** Server namespace watermark of the canonical observation; absent for local identities. */
  observationVersion?: string;
  canonicalRefresh?: { operationId: string; observationVersion?: string };
  /** Exact-ID availability proves this folder is gone, never descendant document deletion. */
  terminal?: { generation: string };
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
  | { kind: "create"; result: CreateUntitledContextDocumentAnswer }
  | { kind: "operation"; receipt: ContextOperationReceipt }
  | { kind: "refusal"; operationId: string; error: MeridianError };

export type NamespaceIdentityAvailability =
  | {
      kind: "available";
      location: ResourceLocation;
      parent: ParentRef;
      observationVersion: string;
      locationVersion?: string;
      rank?: string | null;
      orderPolicy?: ContextParentOrderPolicy;
    }
  | { kind: "deleted"; generation: string; observationVersion: string }
  | { kind: "unavailable" };

/** The caller persists the immutable attempt before submit and retains uncertainty on failure. */
export interface ResourceNamespaceTransport {
  readonly accountId: string;
  lookupIdentity(
    projectId: string,
    identity: { kind: "file" | "folder"; id: string },
  ): Promise<NamespaceIdentityAvailability>;
  readOutcome(projectId: string, request: NamespaceRequest): Promise<NamespaceOutcome | null>;
  submit(projectId: string, request: NamespaceRequest): Promise<NamespaceOutcome | null>;
}

export type ResourceNamespaceLockResult<T> = { kind: "acquired"; value: T } | { kind: "busy" };

/** Every identity/terminal transition shares this short resource lock with namespace dispatch. */
export interface ResourceNamespaceLock {
  readonly accountId: string;
  run<T>(key: ResourceKey, task: () => Promise<T>): Promise<ResourceNamespaceLockResult<T>>;
}
