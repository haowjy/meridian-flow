/**
 * Context-port router: builds a ContextPort that parses a URI, dispatches to the
 * scheme adapter that owns it, resolves Work handles at the project gate, and lifts
 * adapter faults into boundary ContextErrors enriched with the canonical URI.
 */

import { validateContextEntryPath } from "@meridian/contracts/context-entry-validation";
import type { CanonicalContextAuthority, OwnerSlip } from "@meridian/contracts/context-uri";
import {
  type DeleteContextEntryResult,
  filenameForBinary,
  type ParsedDocumentFilename,
  renderFilename,
  storedFilename,
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
  ContextCreateUntitledDocumentOptions,
  ContextCreateUntitledDocumentResult,
  ContextDeleteOptions,
  ContextEnsureTrackedDocumentResult,
  ContextError,
  ContextListing,
  ContextListOptions,
  ContextMoveOptions,
  ContextMoveResult,
  ContextPort,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileRef,
  SearchResult,
  WriteProvenance,
} from "../ports/context-port.js";
import { type ContextTreeDispatch, ContextTreeMover } from "./context-tree-mover.js";
import { callAdapter, toFileEntry, toFileRef, toSearchResult } from "./router-adapter-results.js";
import { type ParseContextUriOptions, parseContextUri, toCanonical } from "./uri.js";

export interface ContextSourceBinding {
  adapter: ContextSchemeAdapter;
  authority: CanonicalContextAuthority;
}

export interface ContextPortRouterDeps {
  resolveDestinationFolder?: (folderId: string) => Promise<string | null>;
  /** The document a device's create id was forwarded to (a join), within this project. */
  resolveForward?: (documentId: string) => Promise<string | null>;
  /** A chat's uploads by handle (`uploads://@c12/`): found, trashed, or no such chat. */
  resolveChatSource?: (
    ref: string,
  ) => Promise<
    { kind: "found"; binding: ContextSourceBinding } | { kind: "unavailable" } | { kind: "missing" }
  >;
  /** Who owns what, for near-miss errors and the owner listings. */
  owners?: ProjectOwners;
  resolveLineageSource?: (ref: string) => Promise<ContextSourceBinding | null>;
  moveLinks?: ConstructorParameters<typeof ContextTreeMover>[2];
  operationReceipts?: import("./context-operation-receipts.js").ContextOperationReceipts;
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

interface Dispatch extends ContextTreeDispatch {
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
   * The first source of this port that shows `documentId` in its reader's view: the
   * contextual sources, No Work's, then every named Work's, each once.
   */
  async function locateDocument(
    documentId: string,
    locateOptions?: { includeDeleted?: boolean },
  ): Promise<Result<{ location: SourceLocation; path: string } | null, ContextError>> {
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
    for (const location of locations) {
      const locationUri = uriFor(location.scheme, "", location.authority);
      const found = await callAdapter(locationUri, () =>
        location.adapter.locateDocument(documentId, locateOptions),
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
  /** The joined document at its current address, or null when no location of this port holds it. */
  async function joinedAnswer(
    documentId: string,
  ): Promise<
    Result<Extract<ContextCreateUntitledDocumentResult, { status: "joined" }> | null, ContextError>
  > {
    const located = await locateDocument(documentId, { includeDeleted: true });
    if (!located.ok) return located;
    if (!located.value) return Ok(null);
    const { location, path } = located.value;
    return Ok({
      status: "joined",
      documentId,
      scheme: location.scheme,
      path,
      name: path.split("/").at(-1) ?? "",
      ...(location.workScopeId ? { workId: location.workScopeId } : {}),
    });
  }

  /**
   * Where a create lands: the destination's parent named by identity (a folder's current
   * address, or a scheme root) under the missing-folder suffix, and the typed leaf. The
   * caller's authority over the resolved address is rechecked here.
   */
  async function untitledTarget(
    homeUri: string,
    home: MutationDispatch,
    options: ContextCreateUntitledDocumentOptions,
  ): Promise<
    Result<
      {
        resolved: MutationDispatch;
        folderPath: string;
        name?: string;
        expectFolderId?: string;
      },
      ContextError
    >
  > {
    const destination = options.destination;
    if (!destination) return Ok({ resolved: home, folderPath: home.path });
    const { parent, name } = destination;
    if (parent.kind === "folder") {
      const resolved = await resolveIdentityDestination(parent, {
        ...(options.authorizeDestination ? { authorize: options.authorizeDestination } : {}),
        ...(options.origin ? { origin: options.origin } : {}),
      });
      if (!resolved.ok) return resolved;
      return Ok({
        resolved: resolved.value,
        folderPath: resolved.value.path,
        name,
        ...(parent.createFolders?.length ? {} : { expectFolderId: parent.folderId }),
      });
    }
    const dirUri = joinContextPath(homeUri, parent.createFolders ?? []);
    if (options.authorizeDestination && !(await options.authorizeDestination(dirUri))) {
      return Err({ code: "permission_denied", uri: dirUri });
    }
    const resolved = await resolveMutation(dirUri);
    if (!resolved.ok) {
      return Err({ code: "destination_missing", uri: homeUri });
    }
    return Ok({ resolved: resolved.value, folderPath: resolved.value.path, name });
  }

  const treeMover = new ContextTreeMover(
    deps.commandTransaction,
    deps.operationReceipts,
    deps.moveLinks,
  );

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
    return Err({
      code: "invalid_uri",
      uri: resolved.value.canonical,
      reason:
        validation.reason === "name/reserved-authority-qualifier"
          ? `File and folder names cannot begin with "@" or "~" (${validation.segment ?? "unknown"})`
          : `Invalid context path (${validation.reason})`,
    });
  }

  /**
   * The destination a writer named by folder identity, with the missing segments beneath it.
   * Create, Move and Copy all resolve it here so one refusal mapping holds: a folder that is
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

  function fileDispatch<T extends Dispatch>(
    dispatch: T,
    binary?: ContextWriteBinaryOptions,
    sourceExtension?: string,
  ): Result<T & { filename: ParsedDocumentFilename }, ContextError> {
    const segments = dispatch.path.split("/");
    const filename = segments.pop() ?? "";
    const parsed = storedFilename(filename, { extension: sourceExtension ?? "" });
    if (!parsed.ok) return Err({ ...parsed.error, uri: dispatch.canonical });
    const parts = binary
      ? filenameForBinary(parsed.filename, binary.fileType, binary.mimeType)
      : parsed.filename;
    const path = [...segments, renderFilename(parts.name, parts.extension)].join("/");
    return Ok({
      ...dispatch,
      filename: parts,
      path,
      canonical: uriFor(dispatch.scheme, path, dispatch.authority),
    });
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

  return {
    lookupOperation: (operationId) =>
      deps.operationReceipts?.lookup(operationId) ?? Promise.resolve(null),

    async resolveFolderUri(folderId: string): Promise<Result<{ uri: string }, ContextError>> {
      const uri = await deps.resolveDestinationFolder?.(folderId);
      return uri ? Ok({ uri }) : Err({ code: "destination_missing", uri: folderId });
    },

    /** One Copy (`copy/` reads, binds and writes; this only resolves its addresses). */
    copy: createContextCopyPort({
      copy: deps.copy,
      receipts: deps.operationReceipts,
      commandTransaction: deps.commandTransaction,
      resolveIdentityDestination,
      resolve,
    }),

    async stat(uri: string): Promise<Result<FileRef, ContextError>> {
      const resolved = await resolve(uri);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, scheme, authority, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.stat(path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok(toFileRef(scheme, authority, result.value, !adapter.capabilities.writable));
    },

    async read(uri: string): Promise<Result<ContextReadResult, ContextError>> {
      const resolved = await resolve(uri);
      if (!resolved.ok) return resolved;
      const r = fileDispatch(resolved.value);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.read(path));
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
      const r = fileDispatch(resolved.value, undefined, options?.sourceExtension);
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

    async createTrackedDocumentAtFreeName(uri, markdown, reserved, options) {
      const resolved = await resolveMutation(uri, options?.origin);
      if (!resolved.ok) return resolved;
      const dispatched = fileDispatch(resolved.value);
      if (!dispatched.ok) return dispatched;
      const permission = dispatched.value.requireCreation(options?.documentId ? "intake" : "entry");
      if (!permission.ok) return permission;
      const { adapter, path, scheme, authority, canonical } = dispatched.value;
      const created = await callAdapter(canonical, () =>
        adapter.createTrackedDocumentAtFreeName(path, markdown, reserved, options),
      );
      return created.ok
        ? Ok({
            documentId: created.value.documentId,
            uri: uriFor(scheme, created.value.path, authority),
          })
        : created;
    },

    createBoundDocument: (uri, bound, options) =>
      createDocument(uri, options, (adapter, path) =>
        adapter.createBoundDocument(path, bound, options),
      ),

    async createUntitledDocument(
      homeUri,
      options,
    ): Promise<Result<ContextCreateUntitledDocumentResult, ContextError>> {
      // Untitled allocation is a writer creation seam, not an AI note operation.
      const home = await resolveMutation(homeUri);
      if (!home.ok) return home;
      const homeCreation = home.value.requireCreation("intake");
      if (!homeCreation.ok) return homeCreation;

      // A create that joined answers from its forward first, under the target's authorization.
      const forwardedTo = await deps.resolveForward?.(options.documentId);
      if (forwardedTo) {
        const joined = await joinedAnswer(forwardedTo);
        if (!joined.ok || joined.value) {
          return joined.ok ? Ok(joined.value as ContextCreateUntitledDocumentResult) : joined;
        }
      }

      const located = await locateDocument(options.documentId);
      if (!located.ok) return located;
      if (located.value) {
        const { location, path: foundPath } = located.value;
        const locationUri = uriFor(location.scheme, "", location.authority);
        const finalized = await callAdapter(locationUri, () =>
          location.adapter.createUntitledDocument(foundPath, {
            documentId: options.documentId,
            origin: options.origin,
          }),
        );
        if (!finalized.ok) return finalized;
        return Ok({
          status: "already-materialized",
          documentId: finalized.value.documentId,
          scheme: location.scheme,
          path: finalized.value.path,
          name: finalized.value.name,
          ...(location.workScopeId ? { workId: location.workScopeId } : {}),
        });
      }

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const target = await untitledTarget(homeUri, home.value, options);
        if (!target.ok) return target;
        const { resolved, folderPath, name, expectFolderId } = target.value;
        const entryCreation = resolved.requireCreation("entry");
        if (!entryCreation.ok) return entryCreation;
        const created = await callAdapter(resolved.canonical, () =>
          resolved.adapter.createUntitledDocument(folderPath, {
            documentId: options.documentId,
            origin: options.origin,
            ...(name !== undefined ? { name } : {}),
            ...(expectFolderId ? { expectFolderId } : {}),
          }),
        );
        if (!created.ok) {
          // The destination folder moved since it was named: name it again.
          if (created.error.code === "stale_target" && expectFolderId) continue;
          return created;
        }
        const address = {
          scheme: resolved.scheme,
          path: created.value.path,
          name: created.value.name,
          ...(resolved.workScopeId ? { workId: resolved.workScopeId } : {}),
        };
        switch (created.value.status) {
          case "created":
            return Ok({ status: "created", documentId: created.value.documentId, ...address });
          case "already-exists":
            return Ok({
              status: "already-materialized",
              documentId: created.value.documentId,
              ...address,
            });
          case "joined": {
            if (created.value.name) {
              return Ok({ status: "joined", documentId: created.value.documentId, ...address });
            }
            const joined = await joinedAnswer(created.value.documentId);
            if (!joined.ok) return joined;
            return joined.value
              ? Ok(joined.value)
              : Ok({ status: "joined", documentId: created.value.documentId, ...address });
          }
        }
      }
      return Err({ code: "conflict", uri: homeUri });
    },

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
      const r = fileDispatch(resolved.value, options);
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
      const result = await callAdapter(canonical, () => adapter.writeBinary(path, options));
      return result.ok ? Ok({ ...result.value, uri: canonical }) : result;
    },

    async move(
      sourceUri: string,
      destinationUri: string,
      options?: ContextMoveOptions,
    ): Promise<Result<ContextMoveResult, ContextError>> {
      const source = await resolve(sourceUri);
      if (!source.ok) return source;
      const destination = await resolveMutation(destinationUri, options?.origin);
      if (!destination.ok) return destination;
      if (
        source.value.scheme === destination.value.scheme &&
        sameOwner(source.value.authority, destination.value.authority)
      ) {
        if (!source.value.adapter.capabilities.writable) {
          return Err({ code: "permission_denied", uri: source.value.canonical });
        }
      } else if (
        !source.value.adapter.capabilities.writable ||
        !destination.value.adapter.capabilities.writable
      ) {
        return Err({ code: "permission_denied", uri: destination.value.canonical });
      }
      const creationDenied = moveCreationDenied(source.value, destination.value);
      if (creationDenied) return creationDenied;
      return treeMover.move(source.value, destination.value, options);
    },

    async commitWriterLocation(sourceUri, destinationUri, options) {
      const source = await resolve(sourceUri);
      if (!source.ok) return source;
      const destination = await resolveMutation(destinationUri);
      if (!destination.ok) return destination;
      const destinationParent = options?.destinationParent;
      if (
        destinationParent?.kind === "root" &&
        (destinationParent.scheme !== destination.value.scheme ||
          (destinationParent.owner.workId !== null &&
            destinationParent.owner.workId !== destination.value.workScopeId))
      )
        return Err({ code: "destination_missing", uri: destinationUri });
      const name = destination.value.path.split("/").at(-1) ?? "";
      const identityParent = destinationParent?.kind === "folder" ? destinationParent : null;
      const resolveDestination = identityParent
        ? async (): Promise<Result<ContextTreeDispatch, ContextError>> => {
            const parent = await resolveIdentityDestination(identityParent, {
              ...(options?.authorizeDestination ? { authorize: options.authorizeDestination } : {}),
              ...(options?.origin ? { origin: options.origin } : {}),
            });
            if (!parent.ok) return parent;
            const target = await resolveMutation(
              joinContextPath(parent.value.path, [name]),
              options?.origin,
            );
            if (!target.ok) return Err({ code: "destination_missing", uri: destinationUri });
            const denied = moveCreationDenied(source.value, target.value);
            return denied ?? target;
          }
        : undefined;
      if (!resolveDestination) {
        const creationDenied = moveCreationDenied(source.value, destination.value);
        if (creationDenied) return creationDenied;
      }
      const { authorizeDestination, ...rest } = options ?? {};
      return treeMover.commitWriterLocation(source.value, destination.value, {
        ...rest,
        ...(resolveDestination
          ? { resolveDestination }
          : authorizeDestination
            ? { authorizeDestination }
            : {}),
      });
    },

    async changeInBranch(command) {
      const { record, changedBy, documentId } = command;
      const source = await resolve(command.op === "move" ? command.sourceUri : command.uri);
      if (!source.ok) return source;
      const sourceTree = source.value.adapter.branchTree;
      if (!sourceTree || !source.value.adapter.capabilities.writable)
        return Err({ code: "permission_denied", uri: source.value.canonical });
      if (command.op === "delete") {
        const deleted = await callAdapter(source.value.canonical, () =>
          sourceTree.delete(source.value.path, { documentId, changedBy, record }),
        );
        return deleted.ok ? Ok({ uri: source.value.canonical, moved: false }) : deleted;
      }
      const destination = await resolveMutation(command.destinationUri);
      if (!destination.ok) return destination;
      const destinationTree = destination.value.adapter.branchTree;
      if (!destinationTree || !destination.value.adapter.capabilities.writable)
        return Err({ code: "permission_denied", uri: destination.value.canonical });
      const creationDenied = moveCreationDenied(source.value, destination.value);
      if (creationDenied) return creationDenied;
      // The source as the branch shows it, for the destination's filetype check.
      const ref = await callAdapter(source.value.canonical, () =>
        source.value.adapter.stat(source.value.path),
      );
      if (!ref.ok) return ref;
      if (ref.value?.documentId !== documentId)
        return Err({ code: "stale_source", uri: source.value.canonical });
      const from = {
        path: source.value.path,
        filetype: ref.value.kind === "tracked" ? ref.value.filetype : null,
        sourceId: await sourceTree.sourceId(),
      };
      const moved = await callAdapter(destination.value.canonical, () =>
        destinationTree.move(destination.value.path, {
          documentId,
          from,
          changedBy,
          record,
          ...(command.position ? { position: command.position } : {}),
        }),
      );
      if (!moved.ok) return moved;
      const { scheme, authority } = destination.value;
      return Ok({ uri: uriFor(scheme, moved.value.path, authority), moved: moved.value.moved });
    },

    async retractCreate(uri, options): Promise<Result<void, ContextError>> {
      const r = await resolveMutation(uri);
      if (!r.ok) return r;
      const { adapter, canonical } = r.value;
      const retracted = await callAdapter(canonical, () =>
        adapter.retractCreate(r.value.path, options.documentId, options.cause),
      );
      if (!retracted.ok) return retracted;
      if (retracted.value.placement === "draft") return Ok(undefined);
      if (!adapter.capabilities.writable) return Err({ code: "permission_denied", uri: canonical });
      const deleted = await treeMover.delete(r.value, {
        expected: { kind: "file", documentId: options.documentId },
        removal: { reason: "discarded", cause: options.cause },
      });
      if (
        !deleted.ok &&
        deleted.error.code !== "not_found" &&
        deleted.error.code !== "stale_target"
      ) {
        return deleted;
      }
      return Ok(undefined);
    },

    async delete(
      uri: string,
      options: ContextDeleteOptions,
    ): Promise<Result<DeleteContextEntryResult, ContextError>> {
      const r = await resolveMutation(uri, options?.origin);
      if (!r.ok) return r;
      if (!r.value.adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: r.value.canonical });
      }
      return treeMover.delete(r.value, options);
    },

    async mkdir(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>> {
      const r = await resolveMutation(uri, options?.origin);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      const creation = r.value.requireCreation("entry");
      if (!creation.ok) return creation;
      return callAdapter(canonical, () => adapter.mkdir(path, options));
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

    async search(query: string, uri?: string): Promise<Result<SearchResult[], ContextError>> {
      if (uri) {
        const r = await resolve(uri);
        if (!r.ok) return r;
        const { adapter, scheme, authority, path, canonical } = r.value;
        if (!adapter.capabilities.searchable) return Ok([]);

        const result = await callAdapter(canonical, () => adapter.search(query, path));
        if (!result.ok) return result;
        return Ok(result.value.map((hit) => toSearchResult(scheme, authority, hit)));
      }

      const hits: SearchResult[] = [];
      for (const [scheme, { adapter, authority }] of await contextualSources()) {
        if (!adapter.capabilities.searchable) continue;
        const result = await callAdapter(`${scheme}://`, () => adapter.search(query));
        if (!result.ok) continue;
        for (const hit of result.value) hits.push(toSearchResult(scheme, authority, hit));
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return Ok(hits);
    },
  };
}
