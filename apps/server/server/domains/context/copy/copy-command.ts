/**
 * Copy: one atomic command per drop, for a selection of roots into one destination.
 *
 * The command reads each source tree once and each tracked document's content once, as the
 * version its surface shows (live, or a draft tab's draft). It then, in order:
 *
 * 1. duplicates every binary's object — bytes leave the database's reach before any row
 *    names them, and their keys are released if no transaction commits to name them (D24);
 * 2. asks the destination adapter to plan the tree (names and identities; a root takes the
 *    device's `copyId` when it sent one), and binds each
 *    document's content for the address its copy will have through
 *    `collab/domain/copied-blocks.ts` — one identity map across the whole selection, so a link
 *    between two roots names both copies. Steps 1-2 and the reads hold no transaction and no
 *    lock: a source room that is not open loads through a second connection, so a transaction
 *    held across the read could starve the pool, and a lock held across them would stall every
 *    writer in the destination for the length of the tree;
 * 3. opens the operation receipt's transaction and, inside it, the command transaction that
 *    takes the destination's Work and namespace (the sources are a frozen cut and are not
 *    locked);
 * 4. rechecks the destination under that lock and asks the destination adapter to insert the
 *    plan. If a concurrent write took a root's name since the plan, the adapter inserts
 *    nothing and the command plans and binds again, now under the lock.
 *
 * A refusal is typed and recorded on the receipt, so a replay reads the same answer. An
 * infrastructure failure, or a source whose room has not yet received the client's edits,
 * records nothing and stays retryable under the same operation ID. A duplicate that arrives
 * while the first attempt is preparing waits for it in this process instead of reading every
 * source again.
 *
 * The answer returns when the rows commit; their projections and link rows are derived after
 * commit without holding the answer. There is no Undo command: Copy's Undo is ordinary
 * deletion of the created identities.
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
import {
  deferUntilDrizzleRollback,
  runAfterDrizzleCommit,
} from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { CollabDomain } from "../../collab/index.js";
import type { ObjectRelease, ObjectStorePort } from "../../storage/index.js";
import { prepareBinaryCopy } from "../binary-copy.js";
import { adapterFaultToContextError } from "../context/adapter-fault.js";
import type { ContextOperationReceipts } from "../context/context-operation-receipts.js";
import type {
  ContextCommandScope,
  ContextCommandTransaction,
} from "../ports/context-command-transaction.js";
import type {
  ContextCopyAdapter,
  CopiedContent,
  CopyCreatedEntry,
  CopyPlan,
  CopySourceEntry,
  CopySourceFile,
  CopySourceFolder,
} from "../ports/context-copy.js";
import type { ContextCopyRequest, ContextError, ContextScheme } from "../ports/context-port.js";

/** How long a read waits for the room to receive the edits a client's vector names. */
const SOURCE_CATCH_UP_MS = 2_000;
const SOURCE_CATCH_UP_POLL_MS = 100;
/** Derivations in flight at once after a copy: each takes a pool connection, and the pool is shared. */
const DERIVE_CONCURRENCY = 4;
/** Documents bound between yields to the event loop. */
const BIND_YIELD_EVERY = 25;

/** One selected root, already resolved to its adapter and read view by the route. */
export interface CopySourceHandoff {
  /** Canonical address of the root. */
  uri: string;
  /** The source scheme's copy capability. */
  copy: ContextCopyAdapter;
  /** Scheme-relative path of the root. */
  path: string;
  view: CopyContextEntryView;
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
}

export interface ContextCopyCommandDeps {
  documentSync: Pick<
    CollabDomain,
    "readEffectiveBlocks" | "bindCopiedBlocks" | "encodeSeed" | "refreshDocumentProjection"
  >;
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
    // The receipt keeps the selection as the writer made it, so a replay is matched against
    // what was sent; the copy works from its outermost roots.
    const selected = { ...input, sources: outermostRoots(input.sources) };
    const { receipts, commandTransaction } = input.environment;
    // A replay has nothing to read: its answer is stored, and receipts are never deleted.
    let replay = await receipts.lookup(input.request.operationId);
    // A duplicate that arrives while the first attempt is still preparing waits for it; the
    // winner's receipt, when it records one, is then the waiter's answer.
    const release = replay ? null : await holdOperation(input.request.operationId);
    try {
      replay = replay ?? (await receipts.lookup(input.request.operationId));
      // Reading holds no transaction. A source room that is not open loads through a second
      // connection, so Copies that each held one while reading would starve the pool they
      // wait on.
      const prepared = replay ? null : await prepare(selected);
      let claimed = false;
      try {
        return await receipts.execute(
          input.request.operationId,
          receiptCommand(input),
          async () => {
            claimed = true;
            if (!prepared)
              throw new Error("A stored receipt vanished between its lookup and its use");
            if (!prepared.ok) return prepared;
            // The rows name these objects only if this operation commits.
            const { putKeys } = prepared.value;
            if (putKeys.length > 0) deferUntilDrizzleRollback(() => deps.release.keys(putKeys));
            return commandTransaction.run(
              () => write(selected, prepared.value),
              [scopeOf(input.destination)],
              { sourceIds: prepared.value.sourceIds },
            );
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
    for (const source of input.sources) {
      const snapshot = await source.copy.snapshotSource(source.path);
      if (!snapshot.ok) return Err(adapterFaultToContextError(snapshot.error, source.uri));
      if (snapshot.value.kind !== source.expected.kind) {
        return Err({ code: "not_found", uri: source.uri });
      }
      if (identityOf(snapshot.value) !== source.expected.nodeId) {
        return Err({ code: "stale_source", uri: source.uri });
      }
      const documents = await prepareDocuments(source, snapshot.value);
      if (!documents.ok) return documents;
      roots.push({
        uri: source.uri,
        snapshot: source.copyId ? { ...snapshot.value, copyId: source.copyId } : snapshot.value,
        documents: documents.value,
      });
    }

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
      // A destination that cannot take a copy is refused where the destination is rechecked,
      // after the stale-destination and inside-itself answers.
      plan: await planAndBind(input.destination, ready, documents),
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
    return Ok({ plan: planned.value, contents: await bind(planned.value, documents) });
  }

  async function bind(
    plan: CopyPlan,
    documents: ReadonlyMap<string, PreparedDocument>,
  ): Promise<Map<string, CopiedContent>> {
    const contents = new Map<string, CopiedContent>();
    for (const { source: file, uri } of plan.documents) {
      const read = documents.get(file.documentId);
      if (!read) throw new Error(`No content was read for ${file.path}`);
      contents.set(file.documentId, {
        state:
          read.blocks.length === 0
            ? null
            : deps.documentSync.encodeSeed(
                deps.documentSync.bindCopiedBlocks({
                  uri,
                  filetype: file.filetype,
                  sourceHolderUri: read.holderUri,
                  blocks: read.blocks,
                  aheadSettlements: read.aheadSettlements,
                  map: plan.map,
                }),
                { type: "system" },
              ),
        copiedFrom: { uri: read.uri, version: read.version, revision: read.revision },
      });
      // Binding is CPU the whole way; let other requests run between documents.
      if (contents.size % BIND_YIELD_EVERY === 0) await delay(0);
    }
    return contents;
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
            storageUrl: file.storageUrl ?? "",
            ...(file.mimeType ? { mimeType: file.mimeType } : {}),
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
          destination: "draft" as const,
          workId: draft.workId,
        }
      : { documentId: file.documentId as DocumentId, destination: "live" as const };
    const client = clientVector ? decodeStateVector(clientVector) : null;
    const deadline = Date.now() + SOURCE_CATCH_UP_MS;
    for (;;) {
      const read = await deps.documentSync.readEffectiveBlocks(command);
      if (!read.ok) {
        switch (read.error.code) {
          case "not_found":
            return Err({ code: "not_found", uri: source.uri });
          case "draft_not_found":
            return Err({
              code: "invalid_operation",
              uri: source.uri,
              message: "That Work has no draft of this document to copy",
              reason: "no_draft",
            });
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
        version: draft ? "draft" : "live",
      });
    }
  }

  /** Under the destination's lock: recheck the destination, then insert the plan. */
  async function write(
    input: ContextCopyInput,
    prepared: PreparedCopy,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const destination = await resolvedDestination(input, prepared);
    if (!destination.ok) return destination;
    const dest = destination.value;

    let planned = prepared.plan;
    let entries: CopyCreatedEntry[] | null = null;
    for (let replans = 0; !entries; replans++) {
      if (!planned.ok) return planned;
      const inserted = await dest.copy.copyInto({
        dir: dest.dir,
        plan: planned.value.plan,
        contents: planned.value.contents,
        ...(input.request.position ? { position: input.request.position } : {}),
      });
      if (!inserted.ok) return Err(adapterFaultToContextError(inserted.error, dest.uri));
      if (inserted.value.kind === "copied") {
        entries = inserted.value.entries;
        break;
      }
      // Under the lock nothing can take the names again, so a second plan must hold.
      if (replans > 0) throw new Error("A copy planned under the namespace lock did not hold");
      planned = await planAndBind(dest, prepared.ready, prepared.documents);
    }
    deriveAfterCommit(
      entries.flatMap((entry) =>
        entry.kind === "file" && prepared.documents.has(entry.copiedFrom)
          ? [entry.id as DocumentId]
          : [],
      ),
    );
    return Ok({ status: "copied", entries: entries.map(toEntry) });
  }

  /**
   * Derive the new documents' projections and link rows once the locks are released: the
   * derivation reads committed rows, so nothing about it needs the namespace held. The
   * answer does not wait for it; a failure is logged by the refresher and the stale sweep
   * recovers the document.
   */
  function deriveAfterCommit(documentIds: readonly DocumentId[]): void {
    if (documentIds.length === 0) return;
    const derive = async () => {
      const queue = [...documentIds];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          await deps.documentSync.refreshDocumentProjection({ documentId: id });
        }
      };
      await Promise.all(Array.from({ length: Math.min(DERIVE_CONCURRENCY, queue.length) }, worker));
    };
    runAfterDrizzleCommit(() => {
      void derive();
    });
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
      resolved.value.scheme !== input.destination.scheme ||
      resolved.value.workScopeId !== input.destination.workScopeId
    ) {
      return Err({ code: "stale_target", uri: input.destination.uri });
    }
    const inside = refuseInsideItself(prepared.roots, resolved.value.uri);
    return inside.ok ? Ok(resolved.value) : inside;
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
  /** The destination's plan and the content bound to it; an error is answered once the destination is rechecked. */
  plan: Result<PlannedCopy, ContextError>;
}

interface PlannedCopy {
  plan: CopyPlan;
  /** Bound content by source document id. */
  contents: Map<string, CopiedContent>;
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
        ...(source.copyId ? { copyId: source.copyId } : {}),
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
