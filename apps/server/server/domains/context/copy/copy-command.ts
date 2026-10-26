/**
 * Copy: one atomic command per drop, for a selection of roots into one destination.
 *
 * The command reads each source tree once and each tracked document's content once, as the
 * version its surface shows (live, or a draft tab's draft). It then, in order:
 *
 * 1. duplicates every binary's object — bytes leave the database's reach before any row
 *    names them, and their keys are released if no transaction commits to name them (D24).
 *    Steps 1 and the reads hold no transaction: a source room that is not open loads through a
 *    second connection, so a transaction held across the read could starve the pool;
 * 2. opens the operation receipt's transaction and, inside it, the command transaction that
 *    takes the source and destination Works and namespaces;
 * 3. rechecks the destination and every root under those locks;
 * 4. asks the destination adapter to insert the tree, binding each document's content for
 *    the address it will have through `collab/domain/copied-blocks.ts` — one identity map
 *    across the whole selection, so a link between two roots names both copies.
 *
 * A refusal is typed and recorded on the receipt, so a replay reads the same answer. An
 * infrastructure failure, or a source whose room has not yet received the client's edits,
 * records nothing and stays retryable under the same operation ID.
 * There is no Undo command: Copy's Undo is ordinary deletion of the created identities.
 */

import { setTimeout as delay } from "node:timers/promises";
import type {
  ContextOperationCommand,
  CopyContextEntriesResult,
  CopyContextEntryCommandSource,
  CopyContextEntryCreated,
  CopyContextEntryView,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { PMNode } from "@meridian/markup";
import { decodeStateVector } from "yjs";
import { deferUntilDrizzleRollback } from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { CollabDomain } from "../../collab/index.js";
import type { ObjectRelease, ObjectStorePort } from "../../storage/index.js";
import { prepareBinaryCopy } from "../binary-copy.js";
import { adapterFaultToContextError } from "../context/adapter-fault.js";
import type { ContextOperationReceipts } from "../context/context-operation-receipts.js";
import type { ContextSchemeAdapter } from "../ports/context-adapter.js";
import type {
  ContextCommandScope,
  ContextCommandTransaction,
} from "../ports/context-command-transaction.js";
import type {
  CopyCreatedEntry,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../ports/context-copy.js";
import type { ContextCopyRequest, ContextError, ContextScheme } from "../ports/context-port.js";

/** How long a read waits for the room to receive the edits a client's vector names. */
const SOURCE_CATCH_UP_MS = 2_000;
const SOURCE_CATCH_UP_POLL_MS = 100;

/** One selected root, already resolved to its adapter and read view by the route. */
export interface CopySourceHandoff {
  /** Canonical address of the root. */
  uri: string;
  adapter: ContextSchemeAdapter;
  /** Scheme-relative path of the root. */
  path: string;
  /** The Work whose lifecycle and namespace this end belongs to; null for no Work. */
  workScopeId: string | null;
  view: CopyContextEntryView;
  expected: { kind: "file" | "folder"; nodeId: string };
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
  adapter: ContextSchemeAdapter;
  /** Scheme-relative path of the destination parent folder. */
  dir: readonly string[];
  /** The Work whose lifecycle and namespace this end belongs to; null for no Work. */
  workScopeId: string | null;
}

export interface ContextCopyCommandDeps {
  documentSync: Pick<CollabDomain, "readEffectiveBlocks" | "bindCopiedBlocks">;
  objectStore: ObjectStorePort;
  release: Pick<ObjectRelease, "keys">;
}

/** The receipt owner and command transaction one authenticated caller's port already holds. */
export interface ContextCopyEnvironment {
  receipts: ContextOperationReceipts;
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

export function createContextCopyCommand(deps: ContextCopyCommandDeps): ContextCopyCommand {
  async function copy(
    input: ContextCopyInput,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    // The receipt keeps the selection as the writer made it, so a replay is matched against
    // what was sent; the copy works from its outermost roots.
    const selected = { ...input, sources: outermostRoots(input.sources) };
    const { receipts, commandTransaction } = input.environment;
    // A replay has nothing to read: its answer is stored, and receipts are never deleted.
    const replay = await receipts.lookup(input.request.operationId);
    // Reading holds no transaction. A source room that is not open loads through a second
    // connection, so Copies that each held one while reading would starve the pool they wait on.
    const prepared = replay ? null : await prepare(selected);
    let claimed = false;
    try {
      return await receipts.execute(input.request.operationId, receiptCommand(input), async () => {
        claimed = true;
        if (!prepared) throw new Error("A stored receipt vanished between its lookup and its use");
        if (!prepared.ok) return prepared;
        // The rows name these objects only if this operation commits.
        const { putKeys } = prepared.value;
        if (putKeys.length > 0) deferUntilDrizzleRollback(() => deps.release.keys(putKeys));
        return commandTransaction.run(() => write(selected, prepared.value), scopesOf(selected), {
          sourceIds: prepared.value.sourceIds,
        });
      });
    } finally {
      // A replay, a mismatch or a throw before the receipt's callback ran leaves them unclaimed.
      if (!claimed && prepared?.ok) await deps.release.keys(prepared.value.putKeys);
    }
  }

  /** Read every source and put every binary's bytes before any transaction or lock is taken. */
  async function prepare(input: ContextCopyInput): Promise<Result<PreparedCopy, ContextError>> {
    const roots: PreparedRoot[] = [];
    const sourceIds = new Set<string>();
    for (const source of input.sources) {
      const copy = source.adapter.copy;
      if (!copy) return unsupportedSource(source.uri);
      const sourceId = await copy.sourceId();
      if (sourceId) sourceIds.add(sourceId);
      const snapshot = await copy.snapshotSource(source.path);
      if (!snapshot.ok) return Err(adapterFaultToContextError(snapshot.error, source.uri));
      if (snapshot.value.kind !== source.expected.kind) {
        return Err({ code: "not_found", uri: source.uri });
      }
      if (identityOf(snapshot.value) !== source.expected.nodeId) {
        return Err({ code: "stale_source", uri: source.uri });
      }
      const documents = await prepareDocuments(source, snapshot.value);
      if (!documents.ok) return documents;
      roots.push({ uri: source.uri, snapshot: snapshot.value, documents: documents.value });
    }

    const destinationSourceId = await input.destination.adapter.copy?.sourceId();
    if (destinationSourceId) sourceIds.add(destinationSourceId);

    const duplicated = await duplicateBinaries(binariesOf(roots));
    if (!duplicated.ok) return duplicated;
    return Ok({ roots, sourceIds: [...sourceIds], ...duplicated.value });
  }

  /** Put a copy of each binary's bytes; if any put fails, the ones already put are released. */
  async function duplicateBinaries(
    binaries: readonly CopySourceFile[],
  ): Promise<Result<{ binaries: Map<string, string>; putKeys: string[] }, ContextError>> {
    const duplicates = new Map<string, string>();
    const putKeys: string[] = [];
    try {
      for (const file of binaries) {
        const duplicated = await prepareBinaryCopy({
          objectStore: deps.objectStore,
          source: {
            uri: file.uri,
            storageUrl: file.storageUrl ?? "",
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
          },
        });
        if (!duplicated.ok) {
          await deps.release.keys(putKeys);
          return duplicated;
        }
        putKeys.push(duplicated.value.key);
        duplicates.set(file.documentId, duplicated.value.storageUrl);
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
    if (source.view.kind === "draft") {
      return Err({
        code: "invalid_operation",
        uri: source.uri,
        message: "A folder copies the live documents in it; open a document to copy its draft",
      });
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
    const command = draft
      ? {
          documentId: file.documentId as DocumentId,
          threadId: draft.threadId,
          destination: "draft" as const,
          workId: draft.workId,
        }
      : { documentId: file.documentId as DocumentId, destination: "live" as const };
    const client = clientVector ? decodeStateVector(clientVector) : null;
    const deadline = Date.now() + SOURCE_CATCH_UP_MS;
    for (;;) {
      const read = await deps.documentSync.readEffectiveBlocks(command);
      if (!read.ok) {
        return read.error.code === "not_found"
          ? Err({ code: "not_found", uri: source.uri })
          : Err({ code: "io_error", uri: source.uri, message: read.error.code });
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
        version: draft ? "draft" : "live",
      });
    }
  }

  /** Under the locks: recheck the destination and every root, then insert the tree. */
  async function write(
    input: ContextCopyInput,
    prepared: PreparedCopy,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const destination = await resolvedDestination(input, prepared);
    if (!destination.ok) return destination;
    const dest = destination.value;

    for (const source of input.sources) {
      const peeked = await source.adapter.copy?.peekSource(source.path);
      if (!peeked?.ok) {
        return peeked
          ? Err(adapterFaultToContextError(peeked.error, source.uri))
          : unsupportedSource(source.uri);
      }
      if (!peeked.value) return Err({ code: "not_found", uri: source.uri });
      if (
        peeked.value.kind !== source.expected.kind ||
        peeked.value.nodeId !== source.expected.nodeId
      ) {
        return Err({ code: "stale_source", uri: source.uri });
      }
    }

    const ready = seededRoots(prepared.roots, prepared.binaries);
    const documents = new Map(
      prepared.roots.flatMap((root) =>
        [...root.documents].map(([documentId, document]) => [documentId, document] as const),
      ),
    );
    const inserted = await dest.adapter.copy?.copyInto({
      dir: dest.dir,
      roots: ready,
      ...(input.request.position ? { position: input.request.position } : {}),
      bind: async ({ file, uri, map }) => {
        const source = documents.get(file.documentId);
        if (!source) {
          return Err({ code: "io_error", message: `No content was read for ${file.path}` });
        }
        return Ok({
          content:
            source.blocks.length === 0
              ? null
              : deps.documentSync.bindCopiedBlocks({
                  uri,
                  filetype: file.filetype,
                  sourceHolderUri: source.holderUri,
                  blocks: source.blocks,
                  aheadSettlements: source.aheadSettlements,
                  map,
                }),
          copiedFrom: { uri: source.uri, version: source.version, revision: source.revision },
        });
      },
    });
    if (!inserted) {
      return Err({
        code: "invalid_operation",
        uri: dest.uri,
        message: "This destination cannot take a copy",
      });
    }
    if (!inserted.ok) return Err(adapterFaultToContextError(inserted.error, dest.uri));
    return Ok({ status: "copied", entries: inserted.value.map(toEntry) });
  }

  async function resolvedDestination(
    input: ContextCopyInput,
    prepared: PreparedCopy,
  ): Promise<Result<CopyDestinationHandoff, ContextError>> {
    const resolved = input.resolveDestination
      ? await input.resolveDestination(input.destination.uri)
      : Ok(input.destination);
    if (!resolved.ok) return resolved;
    if (
      resolved.value.uri !== input.destination.uri ||
      resolved.value.adapter.name !== input.destination.adapter.name ||
      resolved.value.workScopeId !== input.destination.workScopeId
    ) {
      return Err({ code: "stale_target", uri: input.destination.uri });
    }
    const inside = refuseInsideItself(prepared.roots, resolved.value.uri);
    return inside.ok ? Ok(resolved.value) : inside;
  }
  return { copy };
}

/** A source subtree as the destination inserts it, with content bound later. */
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
  /** Every source namespace this command locks. */
  sourceIds: string[];
  /** Old document id → the duplicated object the copy's row will name. */
  binaries: Map<string, string>;
  /** The duplicated objects' keys, released if no row commits to name them. */
  putKeys: string[];
}

function unsupportedSource(uri: string): Result<never, ContextError> {
  return Err({ code: "invalid_operation", uri, message: "This source cannot be copied" });
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

function scopesOf(input: ContextCopyInput): ContextCommandScope[] {
  const ends: ContextCommandScope[] = [
    ...input.sources.map((source) => ({
      scheme: source.adapter.name as ContextScheme,
      workId: source.workScopeId,
    })),
    {
      scheme: input.destination.adapter.name as ContextScheme,
      workId: input.destination.workScopeId,
    },
  ];
  const seen = new Map(ends.map((end) => [`${end.scheme}:${end.workId ?? ""}`, end]));
  return [...seen.values()];
}

function receiptCommand(
  input: ContextCopyInput,
): Extract<ContextOperationCommand, { kind: "copy" }> {
  return {
    kind: "copy",
    sources: input.sources.map(
      (source): CopyContextEntryCommandSource => ({
        uri: source.uri,
        view: source.view,
        expected: source.expected,
      }),
    ),
    destinationUri: input.destination.uri,
    ...(input.request.destinationParent
      ? { destinationParent: input.request.destinationParent }
      : {}),
    ...(input.request.position ? { position: input.request.position } : {}),
  };
}

/** The source's identity for the expected-identity check. */
function identityOf(entry: CopySourceEntry): string {
  return entry.kind === "folder" ? entry.folderId : entry.documentId;
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

/** Rewrite each binary's source entry to the object the copy duplicated. */
function seededRoots(
  roots: readonly PreparedRoot[],
  binaries: ReadonlyMap<string, string>,
): CopySourceEntry[] {
  const reseed = (entry: CopySourceEntry): CopySourceEntry => {
    if (entry.kind === "folder") {
      return { ...entry, children: entry.children.map(reseed) };
    }
    const storageUrl = binaries.get(entry.documentId);
    return storageUrl ? { ...entry, storageUrl } : entry;
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

/** Nothing can land inside a folder it is copying, whichever system either is in. */
function refuseInsideItself(
  roots: readonly PreparedRoot[],
  destinationUri: string,
): Result<void, ContextError> {
  const target = trimTrailingSlash(destinationUri);
  for (const root of roots) {
    if (root.snapshot.kind !== "folder") continue;
    const source = trimTrailingSlash(root.uri);
    if (target === source || target.startsWith(`${source}/`)) {
      return Err({
        code: "invalid_operation",
        uri: root.uri,
        message: "Can't go inside itself",
      });
    }
  }
  return Ok(undefined);
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
