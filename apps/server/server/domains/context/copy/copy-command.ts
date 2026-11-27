import { setTimeout as delay } from "node:timers/promises";
import type { DraftId } from "@meridian/contracts";
import type { Settlement } from "@meridian/contracts/commands";
import type {
  ContextOperationCommand,
  CopyContextEntriesResult,
  CopyContextEntryCommandSource,
  CopyContextEntryCreated,
} from "@meridian/contracts/protocol";
import type { DocumentId } from "@meridian/contracts/runtime";
import { decodeRoomVersion, type RoomVersion, versionCovers } from "@meridian/document-model";
import type { PMNode } from "@meridian/markup";
import { LineageDraftsUnavailableError } from "../../../shared/draft-owner.js";
import {
  requireOutsideTransaction,
  runAfterDrizzleCommit,
} from "../../../shared/drizzle-transaction.js";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { CollabDomain } from "../../collab/index.js";
import { WorkLifecycleUnavailableError } from "../../projects/index.js";
import type { ObjectRelease, ObjectStorePort } from "../../storage/index.js";
import { prepareBinaryCopy } from "../binary-copy.js";
import { adapterFaultToContextError } from "../context/adapter-fault.js";
import type {
  ContextCommandDraft,
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

const SOURCE_CATCH_UP_MS = 2_000;
const SOURCE_CATCH_UP_POLL_MS = 100;

export interface CopySourceHandoff {
  uri: string;
  copy: ContextCopyAdapter;
  path: string;
  view: CopySourceView;
  expected: { kind: "file" | "folder"; nodeId: string };
  copyId?: string;
  roomVersion?: Uint8Array;
}

export interface CopyDestinationHandoff {
  uri: string;
  copy: ContextCopyAdapter;
  scheme: ContextScheme;
  dir: readonly string[];
  workScopeId: string | null;
  parent?: { folderId: string; createFolders: readonly string[] };
  draft: ContextCommandDraft | null;
}

export interface ContextCopyCommandDeps {
  documentSync: Pick<CollabDomain, "readEffectiveBlocks" | "bindCopiedBlocks" | "encodeSeed">;
  objectStore: ObjectStorePort;
  release: Pick<ObjectRelease, "keys">;
}

export interface ContextCopyEnvironment {
  commands: CopyCommands;
  commandTransaction: ContextCommandTransaction;
}

export interface ContextCopyInput {
  environment: ContextCopyEnvironment;
  request: ContextCopyRequest;
  sources: readonly CopySourceHandoff[];
  destination: CopyDestinationHandoff;
  resolveDestination?: (uri: string) => Promise<Result<CopyDestinationHandoff, ContextError>>;
}

export interface ContextCopyCommand {
  copy(input: ContextCopyInput): Promise<Result<CopyContextEntriesResult, ContextError>>;
}

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
    const selected = { ...input, sources: outermostRoots(input.sources) };
    const { commands, commandTransaction } = input.environment;
    let replay = await commands.lookup(input.request.operationId);
    const release = replay ? null : await holdOperation(input.request.operationId);
    try {
      replay = replay ?? (await commands.lookup(input.request.operationId));
      // A source room that is not open loads through a second connection, so Copies that each
      // held a transaction while reading would starve the pool they wait on.
      const prepared = replay ? null : await prepare(selected);
      // The bytes are put once, before the command, which may rerun its transaction: only the
      // attempt that commits a write marks them kept, a rolled-back one's callback is dropped.
      let kept = false;
      try {
        return await commands.execute(
          input.request.operationId,
          receiptCommand(input.sources, input.destination.uri, input.request),
          input.destination.uri,
          async () => {
            if (!prepared)
              throw new Error("A stored receipt vanished between its lookup and its use");
            if (!prepared.ok) return prepared;
            try {
              const written = await commandTransaction.run(
                (command) => write(selected, prepared.value, command.draft?.id ?? null),
                [scopeOf(input.destination)],
                {
                  sourceIds: prepared.value.sourceIds,
                  ...(input.destination.draft ? { draft: input.destination.draft } : {}),
                },
              );
              if (written.ok)
                runAfterDrizzleCommit(() => {
                  kept = true;
                });
              return written;
            } catch (cause) {
              const returned = closedOwnerBounce(cause);
              if (!returned) throw cause;
              return Ok({ status: "copied", entries: [], folders: [], settled: returned });
            }
          },
        );
      } finally {
        if (prepared?.ok && !kept) await deps.release.keys(prepared.value.putKeys);
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
    requireOutsideTransaction("A Copy's read");
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
          ? { kind: "draft" as const, draftId: source.view.draft }
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
      plan: roots.length ? await planAndBind(input.destination, ready, documents) : null,
    });
  }

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
        const prepared = await prepareDocument(source, snapshot, source.roomVersion);
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

  async function prepareDocument(
    source: CopySourceHandoff,
    file: CopySourceFile,
    clientVector?: Uint8Array,
  ): Promise<Result<PreparedDocument, ContextError>> {
    const draft = source.view.kind === "draft" ? source.view : null;
    const documentId = file.documentId as DocumentId;
    const client = clientVector ? decodeRoomVersion(clientVector) : null;
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
      if (client && behind(client, read.value.roomVersion)) {
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

  async function write(
    input: ContextCopyInput,
    prepared: PreparedCopy,
    draftId: DraftId | null,
  ): Promise<Result<CopyContextEntriesResult, ContextError>> {
    const destination = await resolvedDestination(input);
    if (!destination.ok) return destination;
    const dest = destination.value;
    const settled = prepared.settled.length ? { settled: prepared.settled } : {};
    if (!prepared.plan) return Ok({ status: "copied", entries: [], folders: [], ...settled });

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
        draftId,
        ...(input.request.position ? { position: input.request.position } : {}),
      });
      if (!inserted.ok) return Err(adapterFaultToContextError(inserted.error, dest.uri));
      if (inserted.value.kind === "copied") {
        entries = inserted.value.entries;
        folders = inserted.value.folders;
        break;
      }
      if (replans > 0) throw new Error("A copy planned under the namespace lock did not hold");
      planned = await planAndBind(dest, prepared.ready, prepared.documents);
    }
    return Ok({ status: "copied", entries: entries.map(toEntry), folders, ...settled });
  }

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

interface PreparedRoot {
  uri: string;
  snapshot: CopySourceEntry;
  documents: Map<string, PreparedDocument>;
}

interface PreparedDocument {
  file: CopySourceFile;
  uri: string;
  holderUri: string | null;
  blocks: readonly PMNode[];
  aheadSettlements: ReadonlyMap<string, string>;
  revision: string | null;
  version: "live" | "draft";
}

interface PreparedCopy {
  roots: PreparedRoot[];
  sourceIds: string[];
  putKeys: string[];
  ready: CopySourceEntry[];
  documents: Map<string, PreparedDocument>;
  settled: Settlement[];
  plan: Result<PlannedCopy, ContextError> | null;
}

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
  request: Pick<ContextCopyRequest, "destinationParent" | "destinationDraft" | "position">,
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
    ...(request.destinationDraft
      ? {
          destinationView: {
            kind: "draft" as const,
            draft: request.destinationDraft.draftId,
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

type DuplicatedBinary = { storageUrl: string; hasPreview: boolean };

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

function encloses(source: CopySourceHandoff, destinationUri: string): boolean {
  if (source.expected.kind !== "folder") return false;
  const target = trimTrailingSlash(destinationUri);
  const folder = trimTrailingSlash(source.uri);
  return target === folder || target.startsWith(`${folder}/`);
}

function trimTrailingSlash(uri: string): string {
  return uri.endsWith("/") ? uri.slice(0, -1) : uri;
}

function behind(client: RoomVersion, server: Uint8Array): boolean {
  return !versionCovers(decodeRoomVersion(server), client);
}

function closedOwnerBounce(cause: unknown): Settlement[] | undefined {
  if (cause instanceof LineageDraftsUnavailableError)
    return [{ rule: "returned", why: "chat_frozen" }];
  if (cause instanceof WorkLifecycleUnavailableError && cause.state !== "missing")
    return [
      { rule: "returned", why: cause.state === "archived" ? "work_archived" : "work_deleted" },
    ];
  return undefined;
}
