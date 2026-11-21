import type { DraftId } from "@meridian/contracts";
import type { ContextCommandBranch } from "../ports/context-command-transaction.js";
/**
 * Copy: one atomic command per drop, for a selection of roots into one destination.
 *
 * The command reads each source tree once and each tracked document's content once, as the
 * version its surface shows (live, or a draft tab's draft). It then, in order:
 *
 * 1. duplicates every binary's object — bytes leave the database's reach before any row
 *    names them, and their keys are released if no transaction commits to name them;
 * 2. asks the destination adapter to plan the tree (names and identities; a root takes the
 *    device's `copyId` when it sent one), and binds each
 *    document's content for the address its copy will have through
 *    `collab/domain/copied-blocks.ts` — one identity map across the whole selection, so a link
 *    between two roots names both copies. Steps 1-2 and the reads hold no transaction and no
 *    lock: a source room that is not open loads through a second connection, so a transaction
 *    held across the read could starve the pool, and a lock held across them would stall every
 *    writer in the destination for the length of the tree;
 * 3. claims the operation as a `copy` command (`copy-commands.ts`) and, inside it, opens the
 *    command transaction, which takes the destination's Work (the sources are a frozen cut and
 *    are not locked);
 * 4. inserts the plan as one `submit` on the destination's list, which checks under the list's
 *    lock that every root's name is still free. If a concurrent write took one since the plan,
 *    nothing is inserted and the command plans and binds again, now under the lock.
 *
 * Every source and the destination folder are followed by id: a source that moved is copied from
 * where it is, one in Trash from where it was, one whose draft closed from the closed draft. A
 * source that is purged, or a root that would land inside itself, is left out and named in
 * `settled`. A destination in a closed Work stores a `returned` answer and makes nothing. The
 * answer is stored with the command, so a resend reads the same one; another request under the id
 * answers `command_conflict`. An error, or a source whose room has not yet received the client's
 * edits, stores nothing and stays sendable under the same operation ID. A duplicate that arrives
 * while the first attempt is preparing waits for it in this process instead of reading every
 * source again. A resend that does reach the insert (another process) finds its copies' ids taken
 * and answers `conflict`.
 *
 * The answer returns when the rows commit; their projections and link rows are derived after
 * commit without holding the answer. There is no Undo command: Copy's Undo is ordinary
 * deletion of the created identities.
 */

import { setTimeout as delay } from "node:timers/promises";
import type { Settlement } from "@meridian/contracts/commands";
import type {
  ContextOperationCommand,
  CopyContextEntriesResult,
  CopyContextEntryCommandSource,
  CopyContextEntryCreated,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { PMNode } from "@meridian/markup";
import { decodeStateVector } from "yjs";
import { LineageDraftsUnavailableError } from "../../../shared/draft-owner.js";
import { deferUntilDrizzleRollback } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { CollabDomain } from "../../collab/index.js";
import { WorkLifecycleUnavailableError } from "../../projects/index.js";
import type { ObjectRelease, ObjectStorePort } from "../../storage/index.js";
import { prepareBinaryCopy } from "../binary-copy.js";
import { adapterFaultToContextError } from "../context/adapter-fault.js";
import type {
  ContextCommandScope,
  ContextCommandTransaction,
} from "../ports/context-command-transaction.js";
import type {
  ContextCopyAdapter,
  CopyCreatedEntry,
  CopyPlan,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../ports/context-copy.js";
import type {
  ContextCopyRequest,
  ContextError,
  ContextScheme,
  CopySourceView,
} from "../ports/context-port.js";
import { bindTree, type BoundTree as PlannedCopy } from "./bind-tree.js";
import type { CopyCommands } from "./copy-commands.js";

/** How long a read waits for the room to receive the edits a client's vector names. */
const SOURCE_CATCH_UP_MS = 2_000;
const SOURCE_CATCH_UP_POLL_MS = 100;

/** One selected root, already resolved to its adapter and read view by the route. */
export interface CopySourceHandoff {
  /** Canonical address of the root. */
  uri: string;
  /** The source scheme's copy capability. */
  copy: ContextCopyAdapter;
  /** Scheme-relative path of the root. */
  path: string;
  view: CopySourceView;
  expected: { kind: "file" | "folder"; nodeId: string };
  /** The device-minted identity for this root's copy; descendants are server-minted. */
  copyId?: string;
  /**
   * The client's own Yjs state vector, when it holds this document open. Only a file source
   * carries one; the cut compared against it is the view's room.
   */
  stateVector?: Uint8Array;
}

/** Where a copy lands: the destination parent, resolved to its adapter and path. */
export interface CopyDestinationHandoff {
  /** Canonical address of the destination parent folder. */
  uri: string;
  /** The destination scheme's copy capability. */
  copy: ContextCopyAdapter;
  /** The destination scheme, for the command transaction's namespace scope. */
  scheme: ContextScheme;
  /** Scheme-relative path of the destination parent folder. */
  dir: readonly string[];
  /** The Work whose lifecycle and namespace this end belongs to; null for no Work. */
  workScopeId: string | null;
  /** The folder the writer named by id, and the folders to make under it; `dir` spells where it stands. */
  parent?: { folderId: string; createFolders: readonly string[] };
  /** The Work's draft this copy lands in, when the destination is a drafted scheme's draft view. */
  branch: ContextCommandBranch | null;
}

export interface ContextCopyCommandDeps {
  documentSync: Pick<CollabDomain, "readEffectiveBlocks" | "bindCopiedBlocks" | "encodeSeed">;
  objectStore: ObjectStorePort;
  release: Pick<ObjectRelease, "keys">;
}

/** The command transaction one authenticated caller's port already holds. */
export interface ContextCopyEnvironment {
  commands: CopyCommands;
  commandTransaction: ContextCommandTransaction;
}

export interface ContextCopyInput {
  /** The calling port's bound transaction and receipt owner. */
  environment: ContextCopyEnvironment;
  request: ContextCopyRequest;
  sources: readonly CopySourceHandoff[];
  destination: CopyDestinationHandoff;
  /**
   * Resolve an identity destination again under the command's locks. Its answer replaces
   * the route's when it names the same address; anything else is `stale_target`.
   */
  resolveDestination?: (uri: string) => Promise<Result<CopyDestinationHandoff, ContextError>>;
}

export interface ContextCopyCommand {
  copy(input: ContextCopyInput): Promise<Result<CopyContextEntriesResult, ContextError>>;
}

/**
 * Prepares in flight in this process, by operation ID: a duplicate request waits for the
 * first instead of reading every source and binding the tree again. Only a committed receipt
 * is durable; another process would still re-prepare.
 */
const inFlight = new Map<string, Promise<void>>();

function tryHoldOperation(operationId: string): (() => void) | null {
  if (inFlight.has(operationId)) return null;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  inFlight.set(operationId, held);
  return () => {
    inFlight.delete(operationId);
    release();
  };
}

async function holdOperation(operationId: string): Promise<() => void> {
  for (;;) {
    const release = tryHoldOperation(operationId);
    if (release) return release;
    await inFlight.get(operationId);
  }
}

export function createContextCopyCommand(deps: ContextCopyCommandDeps): ContextCopyCommand {
  async function copy(
    input: ContextCopyInput,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    // The copy works from the selection's outermost roots.
    const selected = { ...input, sources: outermostRoots(input.sources) };
    const { commands, commandTransaction } = input.environment;
    // A replay has nothing to read: its answer is stored, and receipts are never deleted.
    let replay = await commands.lookup(input.request.operationId);
    // A duplicate that arrives while the first attempt is still preparing waits for it; the
    // winner's receipt, when it records one, is then the waiter's answer.
    const release = replay ? null : await holdOperation(input.request.operationId);
    try {
      replay = replay ?? (await commands.lookup(input.request.operationId));
      // Reading holds no transaction. A source room that is not open loads through a second
      // connection, so Copies that each held one while reading would starve the pool they
      // wait on.
      const prepared = replay ? null : await prepare(selected);
      let claimed = false;
      try {
        return await commands.execute(
          input.request.operationId,
          receiptCommand(input.sources, input.destination.uri, input.request),
          input.destination.uri,
          async () => {
            claimed = true;
            if (!prepared)
              throw new Error("A stored receipt vanished between its lookup and its use");
            if (!prepared.ok) return prepared;
            // The rows name these objects only if this operation commits.
            const { putKeys } = prepared.value;
            if (putKeys.length > 0) deferUntilDrizzleRollback(() => deps.release.keys(putKeys));
            try {
              return await commandTransaction.run(
                (command) => write(selected, prepared.value, command.branch?.id ?? null),
                [scopeOf(input.destination)],
                {
                  sourceIds: prepared.value.sourceIds,
                  ...(input.destination.branch ? { branch: input.destination.branch } : {}),
                },
              );
            } catch (cause) {
              // The Work lock found the destination's Work closed before anything was written. This
              // command commits, so the objects the plan duplicated are released here.
              const returned = closedOwnerBounce(cause);
              if (!returned) throw cause;
              await deps.release.keys(putKeys);
              return Ok({ status: "copied", entries: [], folders: [], settled: returned });
            }
          },
        );
      } finally {
        // A replay, a mismatch or a throw before the receipt's callback ran leaves them unclaimed.
        if (!claimed && prepared?.ok) await deps.release.keys(prepared.value.putKeys);
      }
    } finally {
      release?.();
    }
  }

  /**
   * Read every source, put every binary's bytes, and plan and bind the tree, before any
   * transaction or lock is taken.
   */
  async function prepare(input: ContextCopyInput): Promise<Result<PreparedCopy, ContextError>> {
    const roots: PreparedRoot[] = [];
    const purged: string[] = [];
    const looping: string[] = [];
    for (const source of input.sources) {
      if (encloses(source, input.destination.uri)) {
        looping.push(source.uri);
        continue;
      }
      const view =
        source.view.kind === "draft"
          ? { kind: "branch" as const, branchId: source.view.draft }
          : { kind: "live" as const };
      const snapshot = await source.copy.snapshotSource({
        id: source.expected.nodeId,
        path: source.path,
        view,
      });
      if (!snapshot.ok) {
        if (snapshot.error.code !== "not_found")
          return Err(adapterFaultToContextError(snapshot.error, source.uri));
        purged.push(source.uri);
        continue;
      }
      const documents = await prepareDocuments(source, snapshot.value);
      if (!documents.ok) {
        if (documents.error.code !== "not_found") return documents;
        purged.push(source.uri);
        continue;
      }
      roots.push({
        uri: source.uri,
        snapshot: source.copyId ? { ...snapshot.value, copyId: source.copyId } : snapshot.value,
        documents: documents.value,
      });
    }
    const settled: Settlement[] = [
      ...(purged.length
        ? [{ rule: "left_out" as const, items: purged, why: "purged" as const }]
        : []),
      ...(looping.length
        ? [{ rule: "left_out" as const, items: looping, why: "would_loop" as const }]
        : []),
    ];

    const duplicated = await duplicateBinaries(binariesOf(roots));
    if (!duplicated.ok) return duplicated;
    const ready = seededRoots(roots, duplicated.value.binaries);
    const documents = new Map(roots.flatMap((root) => [...root.documents]));
    const destinationSourceId = await input.destination.copy.sourceId();
    return Ok({
      roots,
      sourceIds: destinationSourceId ? [destinationSourceId] : [],
      putKeys: duplicated.value.putKeys,
      ready,
      documents,
      settled,
      // A destination that cannot take a copy is refused where the destination is rechecked.
      plan: roots.length ? await planAndBind(input.destination, ready, documents) : null,
    });
  }

  /** Plan the tree at the destination and bind every tracked document's content to its plan. */
  async function planAndBind(
    destination: CopyDestinationHandoff,
    roots: readonly CopySourceEntry[],
    documents: ReadonlyMap<string, PreparedDocument>,
  ): Promise<Result<PlannedCopy, ContextError>> {
    const planned = await destination.copy.planCopy({ dir: destination.dir, roots });
    if (!planned.ok) return Err(adapterFaultToContextError(planned.error, destination.uri));
    return Ok(await bind(planned.value, documents));
  }

  async function bind(plan: CopyPlan, documents: ReadonlyMap<string, PreparedDocument>) {
    return bindTree(plan, ({ source: file, uri }) => {
      const read = documents.get(file.documentId);
      if (!read) throw new Error(`No content was read for ${file.path}`);
      const content =
        read.blocks.length === 0
          ? null
          : deps.documentSync.bindCopiedBlocks({
              uri,
              filetype: file.filetype,
              sourceHolderUri: read.holderUri,
              blocks: read.blocks,
              aheadSettlements: read.aheadSettlements,
              map: plan.map,
            });
      return {
        content,
        state: content ? deps.documentSync.encodeSeed(content, { type: "system" }) : null,
        copiedFrom: { uri: read.uri, version: read.version, revision: read.revision },
      };
    });
  }

  /** Put a copy of each binary's bytes; if any put fails, the ones already put are released. */
  async function duplicateBinaries(
    binaries: readonly CopySourceFile[],
  ): Promise<Result<{ binaries: Map<string, DuplicatedBinary>; putKeys: string[] }, ContextError>> {
    const duplicates = new Map<string, DuplicatedBinary>();
    const putKeys: string[] = [];
    try {
      for (const file of binaries) {
        const duplicated = await prepareBinaryCopy({
          objectStore: deps.objectStore,
          source: {
            uri: file.uri,
            storageUrl: file.storageUrl,
            mimeType: file.mimeType,
            hasPreview: file.hasPreview,
          },
        });
        if (!duplicated.ok) {
          await deps.release.keys(putKeys);
          return duplicated;
        }
        putKeys.push(duplicated.value.key);
        duplicates.set(file.documentId, {
          storageUrl: duplicated.value.storageUrl,
          hasPreview: duplicated.value.hasPreview,
        });
      }
    } catch (error) {
      await deps.release.keys(putKeys);
      throw error;
    }
    return Ok({ binaries: duplicates, putKeys });
  }

  async function prepareDocuments(
    source: CopySourceHandoff,
    snapshot: CopySourceEntry,
  ): Promise<Result<Map<string, PreparedDocument>, ContextError>> {
    const documents = new Map<string, PreparedDocument>();
    if (snapshot.kind === "file") {
      if (snapshot.fileType === null) {
        const prepared = await prepareDocument(source, snapshot, source.stateVector);
        if (!prepared.ok) return prepared;
        documents.set(snapshot.documentId, prepared.value);
      }
      return Ok(documents);
    }
    for (const file of filesOf(snapshot)) {
      if (file.fileType !== null) continue;
      const prepared = await prepareDocument(source, file);
      if (!prepared.ok) return prepared;
      documents.set(file.documentId, prepared.value);
    }
    return Ok(documents);
  }

  /**
   * One document's frozen cut as the source surface shows it. When the client holds the
   * document open its vector is compared with the cut of the view's room, and the read waits
   * a moment for edits still on their way: typing and a drop are seconds apart, not ordered.
   */
  async function prepareDocument(
    source: CopySourceHandoff,
    file: CopySourceFile,
    clientVector?: Uint8Array,
  ): Promise<Result<PreparedDocument, ContextError>> {
    const draft = source.view.kind === "draft" ? source.view : null;
    const documentId = file.documentId as DocumentId;
    const client = clientVector ? decodeStateVector(clientVector) : null;
    const deadline = Date.now() + SOURCE_CATCH_UP_MS;
    for (;;) {
      const read = await deps.documentSync.readEffectiveBlocks(
        draft
          ? { documentId, destination: "draft", draft: draft.draft }
          : { documentId, destination: "live" },
      );
      if (!read.ok) {
        switch (read.error.code) {
          case "not_found":
            return Err({ code: "not_found", uri: source.uri });
          default:
            return Err({ code: "io_error", uri: source.uri, message: read.error.code });
        }
      }
      if (client && behind(client, read.value.stateVector)) {
        if (Date.now() < deadline) {
          await delay(SOURCE_CATCH_UP_POLL_MS);
          continue;
        }
        // Like any transient failure this is `io_error`: retryable, and never recorded, so a
        // replay under the same operation ID reads again instead of being handed the first
        // answer forever. The reason lets the replica stop after a bounded wait.
        return Err({
          code: "io_error",
          uri: source.uri,
          message: "The source has edits the server has not received yet",
          reason: "source_behind",
        });
      }
      return Ok({
        file,
        uri: file.uri,
        holderUri: read.value.holderUri,
        blocks: read.value.content,
        aheadSettlements: read.value.aheadSettlements,
        revision: read.value.revision,
        version: read.value.version,
      });
    }
  }

  /** Under the destination's lock: find the destination again by id, then insert the plan. */
  async function write(
    input: ContextCopyInput,
    prepared: PreparedCopy,
    branchId: DraftId | null,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const destination = await resolvedDestination(input);
    if (!destination.ok) return destination;
    const dest = destination.value;
    const settled = prepared.settled.length ? { settled: prepared.settled } : {};
    if (!prepared.plan) return Ok({ status: "copied", entries: [], folders: [], ...settled });

    // The folder moved after the route found it: the plan was made for its old address.
    let planned =
      dest.uri === input.destination.uri
        ? prepared.plan
        : await planAndBind(dest, prepared.ready, prepared.documents);
    let entries: CopyCreatedEntry[] | null = null;
    let folders: string[] = [];
    for (let replans = 0; !entries; replans++) {
      if (!planned.ok) return planned;
      const inserted = await dest.copy.copyInto({
        dir: dest.dir,
        ...(dest.parent ? { parent: dest.parent } : {}),
        plan: planned.value.plan,
        contents: planned.value.contents,
        branchId,
        ...(input.request.position ? { position: input.request.position } : {}),
      });
      if (!inserted.ok) return Err(adapterFaultToContextError(inserted.error, dest.uri));
      if (inserted.value.kind === "copied") {
        entries = inserted.value.entries;
        folders = inserted.value.folders;
        break;
      }
      // Under the lock nothing can take the names again, so a second plan must hold.
      if (replans > 0) throw new Error("A copy planned under the namespace lock did not hold");
      planned = await planAndBind(dest, prepared.ready, prepared.documents);
    }
    return Ok({ status: "copied", entries: entries.map(toEntry), folders, ...settled });
  }

  /**
   * The destination as it stands under the lock. A folder named by id may have moved since the
   * route found it, which only changes its address; the lock this command holds is the old Work's
   * namespace, so one that moved to another Work or scheme is sent again (nothing is stored).
   */
  async function resolvedDestination(
    input: ContextCopyInput,
  ): Promise<Result<CopyDestinationHandoff, ContextError>> {
    const resolved = input.resolveDestination
      ? await input.resolveDestination(input.destination.uri)
      : Ok(input.destination);
    if (!resolved.ok) return resolved;
    if (
      resolved.value.scheme !== input.destination.scheme ||
      resolved.value.workScopeId !== input.destination.workScopeId ||
      (resolved.value.uri !== input.destination.uri &&
        input.sources.some((source) => encloses(source, resolved.value.uri)))
    ) {
      return Err({
        code: "io_error",
        uri: input.destination.uri,
        message: "The destination moved while the copy was being made",
      });
    }
    return resolved;
  }
  return { copy };
}

/** A source subtree and the content read for its tracked documents. */
interface PreparedRoot {
  uri: string;
  snapshot: CopySourceEntry;
  documents: Map<string, PreparedDocument>;
}

interface PreparedDocument {
  file: CopySourceFile;
  /** Canonical address of the source document, as `metadata.copiedFrom` records it. */
  uri: string;
  /** The address its links spelled from. */
  holderUri: string | null;
  blocks: readonly PMNode[];
  /** Where each `ahead:` ref in the cut points now. */
  aheadSettlements: ReadonlyMap<string, string>;
  revision: string | null;
  version: "live" | "draft";
}

interface PreparedCopy {
  roots: PreparedRoot[];
  /** The destination namespace this command locks; the sources are a frozen cut, not locked. */
  sourceIds: string[];
  /** The duplicated objects' keys, released if no row commits to name them. */
  putKeys: string[];
  /** The source trees with each binary rewritten to the object the copy duplicated. */
  ready: CopySourceEntry[];
  /** Every tracked document's read, by source document id. */
  documents: Map<string, PreparedDocument>;
  /** What the copy left out, named for `settled`. */
  settled: Settlement[];
  /** The destination's plan and the content bound to it; null when no source is left to copy. An error is answered once the destination is rechecked. */
  plan: Result<PlannedCopy, ContextError> | null;
}

/**
 * A selection copies through its outermost roots: a root inside another selected folder, or
 * one selected twice, is already in that copy, and copying it again would give one source two
 * targets and send the folder's internal links to the stray copy.
 */
function outermostRoots(sources: readonly CopySourceHandoff[]): CopySourceHandoff[] {
  const uriOf = (source: CopySourceHandoff) => trimTrailingSlash(source.uri);
  return sources.filter((source, index) => {
    const uri = uriOf(source);
    return !sources.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        ((other.expected.kind === "folder" && uri.startsWith(`${uriOf(other)}/`)) ||
          (uriOf(other) === uri && otherIndex < index)),
    );
  });
}

function scopeOf(destination: CopyDestinationHandoff): ContextCommandScope {
  return { scheme: destination.scheme, workId: destination.workScopeId };
}

export function receiptCommand(
  sources: readonly Pick<CopySourceHandoff, "uri" | "view" | "expected" | "copyId">[],
  destinationUri: string,
  request: Pick<ContextCopyRequest, "destinationParent" | "destinationBranch" | "position">,
): ContextOperationCommand {
  return {
    kind: "copy",
    sources: sources.map(
      (source): CopyContextEntryCommandSource => ({
        uri: source.uri,
        view:
          source.view.kind === "draft" ? { kind: "draft", draft: source.view.draft } : source.view,
        expected: source.expected,
        ...(source.copyId ? { copyId: source.copyId } : {}),
      }),
    ),
    destinationUri,
    ...(request.destinationBranch
      ? {
          destinationView: {
            kind: "draft" as const,
            draft: request.destinationBranch.draftId,
          },
        }
      : {}),
    ...(request.destinationParent ? { destinationParent: request.destinationParent } : {}),
    ...(request.position ? { position: request.position } : {}),
  };
}

function filesOf(folder: CopySourceFolder): CopySourceFile[] {
  return folder.children.flatMap((child) => (child.kind === "folder" ? filesOf(child) : [child]));
}

function binariesOf(roots: readonly PreparedRoot[]): CopySourceFile[] {
  return roots.flatMap((root) =>
    root.snapshot.kind === "folder"
      ? filesOf(root.snapshot).filter((file) => file.fileType !== null)
      : root.snapshot.fileType !== null
        ? [root.snapshot]
        : [],
  );
}

/** The object a copy put for one binary, and whether its preview came along. */
type DuplicatedBinary = { storageUrl: string; hasPreview: boolean };

/** Rewrite each binary's source entry to the object the copy duplicated. */
function seededRoots(
  roots: readonly PreparedRoot[],
  binaries: ReadonlyMap<string, DuplicatedBinary>,
): CopySourceEntry[] {
  const reseed = (entry: CopySourceEntry): CopySourceEntry => {
    if (entry.kind === "folder") {
      return { ...entry, children: entry.children.map(reseed) };
    }
    const duplicate = binaries.get(entry.documentId);
    return duplicate ? { ...entry, ...duplicate } : entry;
  };
  return roots.map((root) => reseed(root.snapshot));
}

function toEntry(entry: CopyCreatedEntry): CopyContextEntryCreated {
  return {
    kind: entry.kind,
    id: entry.id,
    path: entry.path,
    name: entry.name,
    copiedFrom: entry.copiedFrom,
  };
}

/** Whether the destination is the source folder or inside it: nothing can land inside what it copies. */
function encloses(source: CopySourceHandoff, destinationUri: string): boolean {
  if (source.expected.kind !== "folder") return false;
  const target = trimTrailingSlash(destinationUri);
  const folder = trimTrailingSlash(source.uri);
  return target === folder || target.startsWith(`${folder}/`);
}

function trimTrailingSlash(uri: string): string {
  return uri.endsWith("/") ? uri.slice(0, -1) : uri;
}

/** Whether the client's vector names updates this cut does not hold. */
function behind(client: ReadonlyMap<number, number>, server: Uint8Array): boolean {
  const held = decodeStateVector(server);
  for (const [clientId, clock] of client) {
    if (clock > (held.get(clientId) ?? 0)) return true;
  }
  return false;
}

/**
 * The Work lock found the destination's owner closed (an archived or deleted Work, a chat in
 * Trash): the `returned` the command stores in place of the throw. Any other cause is undefined.
 */
function closedOwnerBounce(cause: unknown): Settlement[] | undefined {
  if (cause instanceof LineageDraftsUnavailableError)
    return [{ rule: "returned", why: "chat_frozen" }];
  if (cause instanceof WorkLifecycleUnavailableError && cause.state !== "missing")
    return [
      { rule: "returned", why: cause.state === "archived" ? "work_archived" : "work_deleted" },
    ];
  return undefined;
}
