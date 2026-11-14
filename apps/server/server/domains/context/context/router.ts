/**
 * Context-port router: builds a ContextPort that parses a URI, dispatches to the
 * scheme adapter that owns it, resolves Work handles at the project gate, and lifts
 * adapter faults into boundary ContextErrors enriched with the canonical URI.
 */

import {
  validateContextEntryName,
  validateContextEntryPath,
} from "@meridian/contracts/context-entry-validation";
import type { CanonicalContextAuthority, OwnerSlip } from "@meridian/contracts/context-uri";
import {
  type ContextEntryRef,
  filenameForBinary,
  type ParsedDocumentFilename,
  parseDocumentFilename,
  renderFilename,
} from "@meridian/contracts/protocol";
import type { ResolvedWorkAuthority, WorkHandle } from "@meridian/contracts/works";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type { BoundWrite } from "../../collab/index.js";
import type { ContextCopyCommandDeps } from "../copy/copy-command.js";
import { createContextCopyPort } from "../copy/copy-port.js";
import { type ContextualOwner, type ProjectOwners, unknownWorkMessage } from "../owner-lookup.js";
import type { AdapterFault, ContextSchemeAdapter } from "../ports/context-adapter.js";
import type { ContextCommandTransaction } from "../ports/context-command-transaction.js";
import type {
  ContextBinaryWriteResult,
  ContextCreateTrackedDocumentResult,
  ContextEnsureTrackedDocumentResult,
  ContextError,
  ContextListing,
  ContextListOptions,
  ContextMoveAcrossListsChange,
  ContextMovedAcrossLists,
  ContextPort,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileRef,
  GrepFile,
  GrepQuery,
  GrepResult,
  WriteProvenance,
} from "../ports/context-port.js";
import { invalidEntryError } from "./invalid-entry-error.js";
import { callAdapter, toFileEntry, toFileRef, toGrepFile } from "./router-adapter-results.js";
import { type ParseContextUriOptions, parseContextUri, toCanonical } from "./uri.js";

export interface ContextSourceBinding {
  adapter: ContextSchemeAdapter;
  authority: CanonicalContextAuthority;
}

export interface ContextPortRouterDeps {
  resolveDestinationFolder?: (folderId: string) => Promise<string | null>;
  /** A chat's uploads by handle (`uploads://@c12/`): found, trashed, or no such chat. */
  resolveChatSource?: (
    ref: string,
  ) => Promise<
    { kind: "found"; binding: ContextSourceBinding } | { kind: "unavailable" } | { kind: "missing" }
  >;
  /** Who owns what, for near-miss errors and the owner listings. */
  owners?: ProjectOwners;
  resolveLineageSource?: (ref: string) => Promise<ContextSourceBinding | null>;
  copyCommands?: import("../copy/copy-commands.js").CopyCommands;
  /** Copy's collab cut and bind, and the object store its binaries duplicate into. */
  copy?: ContextCopyCommandDeps;
  sources: ReadonlyMap<
    ContextScheme,
    ContextSourceBinding | (() => Promise<ContextSourceBinding | null>)
  >;
  /** Non-deleted, same-project Work authorities indexed only by exact handle. */
  workAuthorities: ReadonlyMap<WorkHandle, ResolvedWorkAuthority>;
  /** Primary Work for bare Work-scoped URIs in this router. */
  primaryWorkAuthority?: ResolvedWorkAuthority;
  /** Lazily builds Work-scoped adapters for an authority-addressed target Work. */
  resolveWorkAdapters?: (
    authority: ResolvedWorkAuthority,
  ) => ReadonlyMap<ContextScheme, ContextSchemeAdapter>;
  /** The No Work row's id, the work scope of notes written outside any named Work. */
  resolveNoWorkId?: () => Promise<string | null>;
  /** URI parse options — unified port passes manuscript default + extended schemes. */
  parseOptions?: ParseContextUriOptions;
  commandTransaction?: ContextCommandTransaction;
}

interface Dispatch {
  adapter: ContextSchemeAdapter;
  scheme: ContextScheme;
  authority: CanonicalContextAuthority;
  workScopeId: string | null;
  path: string;
  canonical: string;
}

const ENTRY_CREATION_DENIED_MESSAGE =
  "This context scheme does not allow creating files or folders. Use scratch:// as the authoring space. uploads:// accepts files through upload intake.";
const UPLOAD_FOLDER_CREATION_DENIED_MESSAGE =
  "This context scheme accepts flat files through upload intake; folders are not available here.";

function entryCreationDenied(uri: string): Result<never, ContextError> {
  return Err({ code: "invalid_operation", uri, message: ENTRY_CREATION_DENIED_MESSAGE });
}

interface MutationDispatch extends Dispatch {
  requireCreation: (kind: "entry" | "intake") => Result<void, ContextError>;
}

/** A destination named by folder identity, with the missing segments beneath it. */
type IdentityDestination = {
  folderId: string;
  createFolders?: readonly string[];
};

function joinContextPath(base: string, segments: readonly string[]): string {
  return segments.length === 0 ? base : [base.replace(/\/$/, ""), ...segments].join("/");
}

function sameOwner(a: CanonicalContextAuthority, b: CanonicalContextAuthority): boolean {
  if (!("kind" in a)) return !("kind" in b) && a.workId === b.workId;
  if (!("kind" in b) || a.kind !== b.kind) return false;
  if (a.kind === "chat") return b.kind === "chat" && a.chatRef === b.chatRef;
  return a.kind !== "lineage" || (b.kind === "lineage" && a.rootThreadRef === b.rootThreadRef);
}

/** Intake bypasses general entry creation, never the source's actor policy. */
function mutationDispatch(dispatch: Dispatch, origin?: WriteProvenance): MutationDispatch {
  const { adapter, authority, canonical } = dispatch;
  const actorCanCreate =
    !("kind" in authority && authority.kind === "lineage") || origin?.type === "agent";
  return {
    ...dispatch,
    requireCreation(kind) {
      if (!adapter.capabilities.writable || !actorCanCreate)
        return Err({ code: "permission_denied", uri: canonical });
      if (kind === "entry" && !adapter.capabilities.creatable)
        return entryCreationDenied(canonical);
      return Ok(undefined);
    },
  };
}

function moveCreationDenied(source: Dispatch, destination: MutationDispatch) {
  if (source.scheme === destination.scheme && sameOwner(source.authority, destination.authority))
    return null;
  const permission = destination.requireCreation(
    source.scheme === destination.scheme ? "intake" : "entry",
  );
  return permission.ok ? null : permission;
}

/** One source a port can find a document in, and the Work scope it answers for. */
type SourceLocation = {
  scheme: ContextScheme;
  authority: CanonicalContextAuthority;
  workScopeId: string | null;
  adapter: ContextSchemeAdapter;
};

function uriFor(scheme: ContextScheme, path: string, authority: CanonicalContextAuthority): string {
  return toCanonical(scheme, path, authority);
}

export function createContextPortRouter(deps: ContextPortRouterDeps): ContextPort {
  const { sources, parseOptions } = deps;
  /**
   * Every source this port can find an identity in: the contextual sources, No Work's, then
   * every named Work's, each once.
   */
  async function sourceLocations(): Promise<SourceLocation[]> {
    const locations: SourceLocation[] = [];
    const locationKeys = new Set<string>();
    const addLocation = (
      scheme: ContextScheme,
      authority: CanonicalContextAuthority,
      workScopeId: string | null,
      candidate: ContextSchemeAdapter,
    ) => {
      const key = uriFor(scheme, "", authority);
      if (locationKeys.has(key)) return;
      locationKeys.add(key);
      locations.push({ scheme, authority, workScopeId, adapter: candidate });
    };
    const noWorkId = await deps.resolveNoWorkId?.();
    for (const [scheme, { adapter: candidate, authority }] of await contextualSources()) {
      addLocation(
        scheme,
        authority,
        scheme === "scratch" && !("kind" in authority && authority.kind === "lineage")
          ? (deps.primaryWorkAuthority?.workId ?? noWorkId ?? null)
          : null,
        candidate,
      );
    }
    for (const authority of deps.workAuthorities.values()) {
      for (const [scheme, candidate] of deps.resolveWorkAdapters?.(authority) ?? []) {
        addLocation(scheme, authority, authority.workId, candidate);
      }
    }
    return locations;
  }

  /** The first source of this port that shows `documentId` in its reader's view. */
  async function locateDocument(
    documentId: string,
  ): Promise<Result<{ location: SourceLocation; path: string } | null, ContextError>> {
    for (const location of await sourceLocations()) {
      const locationUri = uriFor(location.scheme, "", location.authority);
      const found = await callAdapter(locationUri, () =>
        location.adapter.locateDocument(documentId),
      );
      if (!found.ok) return found;
      if (found.value) return Ok({ location, path: found.value.path });
    }
    return Ok(null);
  }

  async function contextualSources() {
    const bindings = new Map<ContextScheme, ContextSourceBinding>();
    for (const [scheme, source] of sources) {
      const binding = typeof source === "function" ? await source() : source;
      if (binding) bindings.set(scheme, binding);
    }
    return bindings;
  }
  /** The handle this port's contextual source supplies for a scheme, to name in an error. */
  async function contextualHandle(scheme: ContextScheme): Promise<ContextualOwner | null> {
    const source = sources.get(scheme);
    const binding = typeof source === "function" ? await source() : source;
    const authority = binding?.authority;
    if (!authority) return null;
    if ("kind" in authority) {
      if (authority.kind === "lineage") return { kind: "chat", handle: authority.rootThreadRef };
      if (authority.kind === "chat") return { kind: "chat", handle: authority.chatRef };
      return null;
    }
    return authority.workHandle ? { kind: "work", handle: authority.workHandle } : null;
  }

  async function slipReason(slip: OwnerSlip, fallback: string): Promise<string> {
    if (!deps.owners) return fallback;
    const own = slip.kind === "no-handle" ? await contextualHandle(slip.scheme) : null;
    return deps.owners.slipReason(slip, fallback, own);
  }

  async function resolve(uri: string): Promise<Result<Dispatch, ContextError>> {
    const parsed = parseContextUri(uri, parseOptions);
    if (!parsed.ok) {
      const { error } = parsed;
      return error.code === "invalid_uri" && error.slip
        ? Err({ ...error, reason: await slipReason(error.slip, error.reason) })
        : parsed;
    }
    const { scheme, authority, path } = parsed.value;

    const contextual = authority.kind === "contextual" ? sources.get(scheme) : undefined;
    const binding = typeof contextual === "function" ? await contextual() : contextual;
    let adapter = binding?.adapter;
    let canonicalAuthority: CanonicalContextAuthority = binding?.authority ?? {
      kind: "contextual",
    };
    let workScopeId =
      authority.kind === "contextual" ? (deps.primaryWorkAuthority?.workId ?? null) : null;
    // Uploads are a chat's, never a Work's.
    if (
      scheme === "uploads" ||
      ("kind" in canonicalAuthority && canonicalAuthority.kind === "lineage")
    )
      workScopeId = null;
    if (scheme === "uploads" && authority.kind === "chat") {
      const chat = await deps.resolveChatSource?.(authority.chatRef);
      if (chat?.kind !== "found") {
        return Err({
          code: "invalid_uri",
          uri,
          reason:
            chat?.kind === "unavailable"
              ? `The uploads of chat ${authority.chatRef} are unavailable because that chat is in the trash.`
              : `This project has no chat ${authority.chatRef}. Use uploads://x for this chat's files.`,
        });
      }
      adapter = chat.binding.adapter;
      canonicalAuthority = chat.binding.authority;
      workScopeId = null;
    } else if (scheme === "scratch" && authority.kind === "lineage") {
      const lineageSource = await deps.resolveLineageSource?.(authority.rootThreadRef);
      if (!lineageSource) {
        const files = await deps.owners?.chat(authority.rootThreadRef);
        return Err({
          code: "invalid_uri",
          uri,
          reason: files
            ? `Chat ${authority.rootThreadRef}'s notes: ${files.scratch}.`
            : `No first chat ${authority.rootThreadRef}. List owners with ls scratch://@.`,
        });
      }
      adapter = lineageSource.adapter;
      canonicalAuthority = lineageSource.authority;
      workScopeId = null;
    } else if (
      authority.kind === "contextual" &&
      !workScopeId &&
      !("kind" in canonicalAuthority && canonicalAuthority.kind === "lineage") &&
      scheme === "scratch"
    ) {
      workScopeId = (await deps.resolveNoWorkId?.()) ?? workScopeId;
    } else if (authority.kind === "work") {
      const resolvedAuthority = deps.workAuthorities.get(authority.workHandle) ?? null;
      if (!resolvedAuthority) {
        return Err({
          code: "invalid_uri",
          uri: parsed.value.normalized,
          reason: deps.owners
            ? await deps.owners.unknownWork(authority.workHandle)
            : unknownWorkMessage(authority.workHandle),
          workHandle: authority.workHandle,
        });
      }
      try {
        adapter = deps.resolveWorkAdapters
          ? deps.resolveWorkAdapters(resolvedAuthority).get(scheme)
          : (await contextualSources()).get(scheme)?.adapter;
        workScopeId = resolvedAuthority.workId;
        canonicalAuthority = resolvedAuthority;
      } catch (error) {
        return Err({
          code: "io_error",
          uri: parsed.value.normalized,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (scheme === "uploads" && authority.kind === "contextual" && !adapter)
      return Err({
        code: "invalid_uri",
        uri,
        reason: "No uploads owner here. Use ls uploads://@.",
      });
    if (scheme === "scratch" && authority.kind === "contextual" && !adapter)
      return Err({
        code: "invalid_uri",
        uri,
        reason: "No scratch owner here. Use ls scratch://@.",
      });
    const canonical = toCanonical(scheme, path, canonicalAuthority);

    if (!adapter) {
      return Err({
        code: "invalid_uri",
        uri: canonical,
        reason: `No adapter registered for scheme "${scheme}"`,
      });
    }
    return Ok({
      adapter,
      scheme,
      authority: canonicalAuthority,
      workScopeId,
      path,
      canonical,
    });
  }

  async function resolveMutation(
    uri: string,
    origin?: WriteProvenance,
  ): Promise<Result<MutationDispatch, ContextError>> {
    const resolved = await resolve(uri);
    if (!resolved.ok) return resolved;
    const validation = validateContextEntryPath(resolved.value.path, { allowRoot: true });
    if (validation.ok) return Ok(mutationDispatch(resolved.value, origin));
    return Err(invalidEntryError(resolved.value.canonical, validation));
  }

  /**
   * The destination a writer named by folder identity, with the missing segments beneath it.
   * Copy resolves it here so one refusal mapping holds: a folder that is
   * gone (or an address that no longer resolves) is `destination_missing`; a destination the
   * writer cannot edit is `permission_denied`.
   */
  async function resolveIdentityDestination(
    parent: IdentityDestination,
    options: { authorize?: (uri: string) => Promise<boolean>; origin?: WriteProvenance } = {},
  ): Promise<Result<MutationDispatch, ContextError>> {
    const folderUri = await deps.resolveDestinationFolder?.(parent.folderId);
    if (!folderUri) return Err({ code: "destination_missing", uri: parent.folderId });
    const dirUri = joinContextPath(folderUri, parent.createFolders ?? []);
    const resolved = await resolveMutation(dirUri, options.origin);
    if (!resolved.ok) return Err({ code: "destination_missing", uri: dirUri });
    if (options.authorize && !(await options.authorize(resolved.value.canonical))) {
      return Err({ code: "permission_denied", uri: resolved.value.canonical });
    }
    return resolved;
  }

  /** The dispatch with its leaf rendered from the parts the name codec or the caller decided. */
  function withFilename<T extends Dispatch, P extends { name: string; extension: string }>(
    dispatch: T,
    parts: P,
  ): T & { filename: P } {
    const path = [
      ...dispatch.path.split("/").slice(0, -1),
      renderFilename(parts.name, parts.extension),
    ].join("/");
    return {
      ...dispatch,
      filename: parts,
      path,
      canonical: uriFor(dispatch.scheme, path, dispatch.authority),
    };
  }

  function fileDispatch<T extends Dispatch>(
    dispatch: T,
    sourceExtension?: string,
  ): Result<T & { filename: ParsedDocumentFilename }, ContextError> {
    const parsed = parseDocumentFilename(dispatch.path.split("/").pop() ?? "", { sourceExtension });
    return parsed.ok
      ? Ok(withFilename(dispatch, parsed.value))
      : Err({ ...parsed.error, uri: dispatch.canonical });
  }

  /** A binary's dispatch: a prose-shaped name takes its storage type's registered suffix. */
  function binaryDispatch<T extends Dispatch>(
    dispatch: T,
    binary: ContextWriteBinaryOptions,
  ): Result<T & { filename: { name: string; extension: string } }, ContextError> {
    let parts: { name: string; extension: string } | undefined = binary.filename;
    if (!parts) {
      const parsed = parseDocumentFilename(dispatch.path.split("/").pop() ?? "");
      if (!parsed.ok) return Err({ ...parsed.error, uri: dispatch.canonical });
      parts = parsed.value;
    }
    return Ok(withFilename(dispatch, filenameForBinary(parts, binary.fileType, binary.mimeType)));
  }

  /** Claim a new tracked URI through its adapter: the checks both create entries share. */
  async function createDocument(
    uri: string,
    options: ContextWriteOptions | undefined,
    create: (
      adapter: ContextSchemeAdapter,
      path: string,
    ) => Promise<Result<Omit<ContextCreateTrackedDocumentResult, "uri">, AdapterFault>>,
  ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>> {
    const resolved = await resolveMutation(uri, options?.origin);
    if (!resolved.ok) return resolved;
    const r = fileDispatch(resolved.value);
    if (!r.ok) return r;
    const permission = r.value.requireCreation(options?.documentId ? "intake" : "entry");
    if (!permission.ok) return permission;
    const { adapter, path, canonical } = r.value;
    const created = await callAdapter(canonical, () => create(adapter, path));
    return created.ok ? Ok({ ...created.value, uri: canonical }) : created;
  }

  /**
   * Move `node` from the list of `source` into the destination's: the destination adapter
   * writes both lists, wherever the node is by then, and the command is refused when it no
   * longer stands in the area the caller named.
   */
  async function moveNodeAcrossLists(
    node: ContextEntryRef,
    source: Dispatch,
    destination: Dispatch,
    change: ContextMoveAcrossListsChange,
  ): Promise<Result<ContextMovedAcrossLists, ContextError>> {
    let leaf: string | undefined;
    if (change.name !== undefined) {
      const named = validateContextEntryName(change.name);
      if (!named.ok) return Err(invalidEntryError(destination.canonical, named));
      leaf = named.value;
    }
    const { adapter } = destination;
    if (!source.adapter.capabilities.writable || !adapter.capabilities.writable || !adapter.tree)
      return Err({ code: "permission_denied", uri: destination.canonical });
    const tree = adapter.tree;
    const sourceTree = source.adapter.tree;
    if (!sourceTree) return Err({ code: "permission_denied", uri: source.canonical });
    const moved = await callAdapter(destination.canonical, async () =>
      tree.moveAcrossLists({
        node,
        fromSourceId: await sourceTree.sourceId(),
        dir: destination.path.split("/").filter(Boolean),
        ...(leaf !== undefined ? { leaf } : {}),
        ...(change.position ? { position: change.position } : {}),
        ...(change.onlyAt !== undefined ? { onlyAt: change.onlyAt } : {}),
        ...(change.origin ? { origin: change.origin } : {}),
        afterWrite: (written) =>
          change.inTransaction?.({
            destinationUri: uriFor(destination.scheme, written.path, destination.authority),
            node: written.node,
            records: written.records,
          }) ?? Promise.resolve(),
      }),
    );
    if (!moved.ok) return moved;
    return Ok({
      destinationUri: uriFor(destination.scheme, moved.value.path, destination.authority),
      node: moved.value.node,
      records: moved.value.records,
    });
  }

  return {
    async resolveFolderUri(folderId: string): Promise<Result<{ uri: string }, ContextError>> {
      const uri = await deps.resolveDestinationFolder?.(folderId);
      return uri ? Ok({ uri }) : Err({ code: "destination_missing", uri: folderId });
    },

    /** One Copy (`copy/` reads, binds and writes; this only resolves its addresses). */
    copy: createContextCopyPort({
      copy: deps.copy,
      commands: deps.copyCommands,
      commandTransaction: deps.commandTransaction,
      resolveIdentityDestination,
      resolve,
    }),

    async stat(uri: string): Promise<Result<FileRef, ContextError>> {
      const resolved = await resolve(uri);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, scheme, authority, canonical } = r.value;

      // The adapter gets the path as written: it tries the exact stored name before the
      // codec's, so a file kept as `binary.md` is found beside a document `binary`.
      const result = await callAdapter(canonical, () => adapter.stat(resolved.value.path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok(toFileRef(scheme, authority, result.value, !adapter.capabilities.writable));
    },

    async read(uri: string): Promise<Result<ContextReadResult, ContextError>> {
      const resolved = await resolve(uri);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.read(resolved.value.path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok({ ...result.value, uri: canonical });
    },

    async write(
      uri: string,
      content: string,
      options?: ContextWriteOptions,
    ): Promise<Result<ContextWriteResult, ContextError>> {
      const resolved = await resolveMutation(uri, options?.origin);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      const result = await callAdapter(canonical, () => adapter.write(path, content, options));
      return result.ok ? Ok({ ...result.value, uri: canonical }) : result;
    },

    async ensureTrackedDocument(
      uri: string,
      options?: import("../ports/context-adapter.js").ContextEnsureTrackedOptions,
    ): Promise<Result<ContextEnsureTrackedDocumentResult, ContextError>> {
      const resolved = await resolveMutation(uri, options?.origin);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value, options?.sourceExtension);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      const creation = r.value.requireCreation("entry");
      if (!creation.ok) return creation;
      const ensured = await callAdapter(canonical, () =>
        adapter.ensureTrackedDocument(path, { ...options, parsedFilename: r.value.filename }),
      );
      return ensured.ok ? Ok({ ...ensured.value, uri: canonical }) : ensured;
    },

    async bindTrackedDocument(
      uri: string,
      content: string,
    ): Promise<Result<BoundWrite, ContextError>> {
      const resolved = await resolveMutation(uri);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      // Binding only prepares syntax and refs. The shared creation door checks
      // the eventual origin and reservation identity, including intake policy.
      if (!adapter.capabilities.writable) return Err({ code: "permission_denied", uri: canonical });
      return callAdapter(canonical, () => adapter.bindTrackedDocument(path, content));
    },

    createTrackedDocument: (uri, markdown, options) =>
      createDocument(uri, options, (adapter, path) =>
        adapter.createTrackedDocument(path, markdown, options),
      ),

    createBoundDocument: (uri, bound, options) =>
      createDocument(uri, options, (adapter, path) =>
        adapter.createBoundDocument(path, bound, options),
      ),

    async locate(documentId) {
      const located = await locateDocument(documentId);
      if (!located.ok) return located;
      if (!located.value) return Ok(null);
      const { location, path } = located.value;
      return Ok({ documentId, uri: uriFor(location.scheme, path, location.authority) });
    },

    async writeBinary(
      uri: string,
      options: ContextWriteBinaryOptions,
    ): Promise<Result<ContextBinaryWriteResult, ContextError>> {
      const resolved = await resolveMutation(uri, options?.origin);
      if (!resolved.ok) return resolved;
      const r = binaryDispatch(resolved.value, options);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      const creation = r.value.requireCreation("intake");
      if (!creation.ok) return creation;
      if (!adapter.capabilities.creatable && path.includes("/")) {
        return Err({
          code: "invalid_operation",
          uri: canonical,
          message: UPLOAD_FOLDER_CREATION_DENIED_MESSAGE,
        });
      }
      const result = await callAdapter(canonical, () =>
        adapter.writeBinary(path, { ...options, filename: r.value.filename }),
      );
      return result.ok ? Ok({ ...result.value, uri: canonical }) : result;
    },

    async moveAcrossLists(node, area, change) {
      const source = await resolve(area);
      if (!source.ok) return source;
      const folder = await resolveMutation(change.folderUri);
      if (!folder.ok) return folder;
      const denied = moveCreationDenied(source.value, folder.value);
      if (denied) return denied;
      return moveNodeAcrossLists(node, source.value, folder.value, change);
    },

    async delete(node, area, options = {}) {
      const r = await resolve(area);
      if (!r.ok) return r;
      const { adapter, canonical } = r.value;
      if (!adapter.capabilities.writable || !adapter.tree)
        return Err({ code: "permission_denied", uri: canonical });
      const tree = adapter.tree;
      const deleted = await callAdapter(canonical, async () =>
        tree.delete({
          node,
          fromSourceId: await tree.sourceId(),
          ...(options.onlyAt !== undefined ? { onlyAt: options.onlyAt } : {}),
          ...(options.origin ? { origin: options.origin } : {}),
          afterWrite: async (written) => {
            await options.inTransaction?.({
              uri: uriFor(r.value.scheme, written.path, r.value.authority),
              documentIds: written.documentIds,
            });
          },
        }),
      );
      if (!deleted.ok) return deleted;
      return Ok({
        uri: uriFor(r.value.scheme, deleted.value.path, r.value.authority),
        documentIds: deleted.value.documentIds,
      });
    },

    async treeCommand(area, input) {
      const r = await resolve(area);
      if (!r.ok) return r;
      const { adapter, canonical } = r.value;
      if (!adapter.capabilities.writable || !adapter.tree)
        return Err({ code: "permission_denied", uri: canonical });
      const tree = adapter.tree;
      return callAdapter(canonical, () => tree.command(input));
    },

    async readTree(area, input) {
      const r = await resolve(area);
      if (!r.ok) return r;
      const { adapter, canonical } = r.value;
      if (!adapter.tree) return Err({ code: "permission_denied", uri: canonical });
      const tree = adapter.tree;
      return callAdapter(canonical, () => tree.read(input));
    },

    async list(
      uri?: string,
      options?: ContextListOptions,
    ): Promise<Result<ContextListing, ContextError>> {
      if (!uri) {
        return Ok({
          uri: null,
          entries: [...(await contextualSources())]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([scheme, { adapter }]) => ({
              kind: "directory" as const,
              uri: `${scheme}://`,
              readonly: !adapter.capabilities.writable,
            })),
        });
      }
      const listed = parseContextUri(uri, parseOptions);
      if (listed.ok && listed.value.authority.kind === "owners") {
        const { scheme } = listed.value;
        const rows =
          scheme === "scratch"
            ? await deps.owners?.scratchOwners()
            : scheme === "uploads"
              ? await deps.owners?.uploadOwners()
              : [];
        return Ok({
          uri: listed.value.normalized,
          entries: (rows ?? []).map((row) => ({
            kind: "directory" as const,
            uri: row.uri,
            title: row.label,
            readonly: false,
          })),
        });
      }
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, scheme, authority, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.list(path, options));
      if (!result.ok) return result;

      const readonly = !adapter.capabilities.writable;
      return Ok({
        uri: canonical,
        entries: result.value.map((entry) => toFileEntry(scheme, authority, entry, readonly)),
      });
    },

    async grep(query: GrepQuery): Promise<Result<GrepResult, ContextError>> {
      if (query.path) {
        const r = await resolve(query.path);
        if (!r.ok) return r;
        const { adapter, scheme, authority, path, canonical } = r.value;
        if (!adapter.capabilities.searchable) return Ok({ files: [], totalFiles: 0, exact: true });
        const result = await callAdapter(canonical, () => adapter.grep({ ...query, path }));
        if (!result.ok) return result;
        const { files, ...rest } = result.value;
        return Ok({ files: files.map((file) => toGrepFile(scheme, authority, file)), ...rest });
      }

      // Each source gets what the limit has left; a source reached after it still counts its
      // files, which costs no reads.
      const found: GrepFile[] = [];
      let totalFiles = 0;
      let exact = true;
      let stopped = false;
      for (const [scheme, { adapter, authority }] of await contextualSources()) {
        if (!adapter.capabilities.searchable) continue;
        const result = await callAdapter(`${scheme}://`, () =>
          adapter.grep({ ...query, headLimit: query.headLimit - found.length }),
        );
        if (!result.ok) continue;
        for (const file of result.value.files) found.push(toGrepFile(scheme, authority, file));
        totalFiles += result.value.totalFiles;
        exact &&= result.value.exact;
        stopped ||= result.value.stopped === true;
      }
      return Ok({ files: found, totalFiles, exact, ...(stopped ? { stopped } : {}) });
    },
  };
}
