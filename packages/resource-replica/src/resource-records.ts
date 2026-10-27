/** Durable resource identity and namespace work; independent of storage and content transport. */
import type {
  CatalogEntry,
  CatalogFileClassification,
  CatalogScope,
  ContextOperationReceipt,
  ContextParentOrderPolicy,
  ContextSiblingPosition,
  CreateContextFolderRequest,
  CreateContextFolderResponse,
  CreateUntitledContextDocumentAnswer,
  CreateUntitledContextDocumentRequest,
  DeleteContextEntryRequest,
  MeridianError,
  MoveContextEntryRequest,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "./catalog";
import type { ServerHold } from "./server-hold";

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

/**
 * How the server first makes a document identity it does not hold yet, while the writer's first
 * placement of that one document carries the request. Placement says where it goes; this says
 * what the server makes there, so a new kind of single-document materialization adds an arm here
 * and nowhere else. Copy is not one: one Copy names several roots and answers with an operation
 * receipt, so it is an `OperationRecord`, and each root it makes carries `copiedBy` instead of a
 * materialization.
 */
export type DocumentMaterialization = {
  kind: "untitled";
  /** Where an unnamed create lands; empty is Unfiled's root. */
  folderPath: string;
  /** The row's name until the server names the document. */
  provisionalName: string;
  /**
   * The editor's nameless create: the writer has not chosen a name or place, so the document
   * keeps inviting a home until the catalog publishes the server's `provisionalName`. A writer
   * placement clears it; the server chooses where this create lands.
   */
  unnamed?: true;
};

/** The home a document the writer has not placed lands at, as its first placement names it. */
export function untitledDestination(folderPath: string, name: string): ResourceDestination {
  const createFolders = folderPath.split("/").filter(Boolean);
  return {
    parent: { kind: "root", scheme: "unfiled", owner: { workId: null } },
    ...(createFolders.length ? { createFolders } : {}),
    name,
  };
}

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

/**
 * The operation that made a record: the record is one root of it (a Copy), and the operation's
 * receipt, not a create of the record's own, gives it its first place (`first-place.ts`).
 */
export type CopiedBy = { operationId: string };

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
  /**
   * How the server first materializes this identity, while it holds no such document: an untitled
   * document. Placement is separate and always a location intent, so a refused first placement is
   * repaired by placing it again, not by a new request kind. Absent for a document installed from
   * the catalog.
   */
  materialization?: DocumentMaterialization;
  /** What the server holds under this document id, as its answers prove (`server-hold.ts`). */
  serverHold: ServerHold;
  /** Set when an operation made this document; absent for one that holds its own create. */
  copiedBy?: CopiedBy;
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
    cleanup?: {
      obligationId: string;
      exactDatabaseName: string;
      /** A local deletion's Undo window: the content is kept until then (epoch ms). */
      notBefore?: number;
    };
  };
};

/** The endpoint's authority is part of the submitted request, not inferred from current UI state. */
export type NamespaceRequest =
  | { kind: "create"; body: CreateUntitledContextDocumentRequest }
  | {
      kind: "create-folder";
      /** Owner of the destination parent when sent, so the answer's path becomes a full location. */
      owner: ResourceOwner;
      body: CreateContextFolderRequest;
    }
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

/**
 * The identity a request is replayed under: a move's or delete's operation id, a create's document
 * or folder id (the server dedupes a create by it). A refusal names it, so a request kind added
 * later must state its own identity here.
 */
export function namespaceRequestId(request: NamespaceRequest): string {
  switch (request.kind) {
    case "create":
      return request.body.documentId;
    case "create-folder":
      return request.body.folderId;
    default:
      return request.body.operationId;
  }
}

/** Every request kind can be refused; only its accepted answer differs. */
export type NamespaceAttempt = {
  [Kind in NamespaceRequest["kind"]]: {
    attemptId: string;
    request: Extract<NamespaceRequest, { kind: Kind }>;
    outcome?:
      | Extract<NamespaceOutcome, { kind: "refusal" }>
      | (Kind extends "create" | "create-folder"
          ? Extract<NamespaceOutcome, { kind: Kind }>
          : {
              kind: "operation";
              receipt: Extract<ContextOperationReceipt, { command: { kind: Kind } }>;
            });
  };
}[NamespaceRequest["kind"]];

/**
 * A placement a later one waits on, named by its admission `order` in the journal of `kind` under
 * `handle` (an operation's handle is its operation id). The order is the placement's logical
 * identity: a remint replaces its intent but the replacement inherits the admission, so the
 * reference follows it (`latestAdmittedPlacement`).
 */
export type PlacementPredecessor = {
  kind: "resource" | "folder" | "operation";
  handle: string;
  order: number;
  /** The later intent's position names this predecessor's subject, so a failure changes its premise. */
  anchor?: true;
};

/**
 * Where a placement stands in the account's causal order. Written once with the intent, under the
 * account's cross-tab admission lock, and never revised: dispatch, projection and Undo all read it.
 */
export type PlacementAdmission = {
  /** Account-wide admission sequence, comparable across file and folder journals. */
  order: number;
  /** Conflict keys: the subject, the sibling sequences it leaves and joins, its anchor and destination ancestry. */
  scope: readonly string[];
  /** Intents still unresolved at admission whose scope overlaps; they dispatch first. */
  predecessors: readonly PlacementPredecessor[];
};

export type NamespaceIntent = ResourceKey & {
  projectId: string;
  intentId: string;
  /** Caller-issued id lets surfaces correlate settlement before background dispatch. */
  operationId?: string;
  sequence: number;
  /** Placement ordering captured at admission; see `PlacementAdmission`. */
  admission?: PlacementAdmission;
  identityRevision: number;
  desired:
    | {
        kind: "set-location";
        /** Original input; canonical destination is only for display and comparison. */
        typedName: string;
        /**
         * Where the writer put the document. The editor's nameless create names its materialized
         * home (`untitledDestination`) until the writer places it somewhere else.
         */
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

/**
 * A folder is namespace identity only: it never owns a document id, content or classification.
 * A folder the server has not accepted yet is local: no canonical place, only its create.
 */
export type FolderNamespaceRecord = ResourceKey & {
  /** Null for account-owned personal folders; command projects live on the intents. */
  projectId: string | null;
  folderId: string;
  /** Ids this folder was minted under before a remint (`folder-remint.ts`); attempts name them. A list so the store can index it. */
  aliases?: readonly string[];
  revision: number;
  /** What the server holds under `folderId`, as its answers prove (`server-hold.ts`). */
  serverHold: ServerHold;
  /** Set when an operation made this folder; absent for one that holds its own create. */
  copiedBy?: CopiedBy;
  /** Null while the folder is local: its first placement has not been accepted. */
  canonical: ResourceLocation | null;
  /** Parent identity installed atomically with the canonical location. */
  canonicalParent?: ParentRef;
  /** This folder's rank and child-order policy from the same canonical observation. */
  canonicalRank?: string | null;
  canonicalLocationVersion?: string;
  canonicalOrderPolicy?: ContextParentOrderPolicy;
  /** Server namespace watermark of the canonical observation; absent for local identities. */
  observationVersion?: string;
  canonicalRefresh?: { operationId: string; observationVersion?: string };
  /** A local deletion's Undo window: the folder, its place and its children stay recoverable until then (epoch ms). */
  localDeletion?: { obligationId: string; notBefore: number };
  /** Exact-ID availability proves this folder is gone, never descendant document deletion. */
  terminal?: { generation: string };
  intents: readonly NamespaceIntent[];
};

export type FolderNamespaceWrite = {
  expectedRevision: number | null;
  next: FolderNamespaceRecord;
};

/**
 * One writer action over several records (a Copy), journaled once under its operation id: the
 * operation's own intents and attempts, apart from the records it creates. Every intent's `handle`
 * is the `operationId`, so the generic journal, placement admission and predecessors address an
 * operation as they do a resource or a folder.
 */
export type OperationRecord = {
  operationId: string;
  projectId: string;
  revision: number;
  intents: readonly NamespaceIntent[];
};

export type OperationWrite = {
  expectedRevision: number | null;
  next: OperationRecord;
};

/** What the replica needs of an operation from a record's side: its journal, by id. */
export interface OperationReader {
  readOperation(operationId: string): Promise<OperationRecord | null>;
}

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
  operations: readonly OperationRecord[];
  catalogs: readonly ResourceCatalogCheckpoint[];
};

/** All mutation results mean outer commit. Network, locks and Yjs work stay outside these calls. */
export interface ResourceMetadataStore extends OperationReader {
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
  | { kind: "create-folder"; result: CreateContextFolderResponse }
  | { kind: "operation"; receipt: ContextOperationReceipt }
  /** A typed, non-retryable 4xx answering the request `operationId` names (`namespaceRequestId`). */
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
