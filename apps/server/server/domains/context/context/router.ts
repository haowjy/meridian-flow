/**
 * Context-port router: builds a ContextPort that parses a URI, dispatches to the
 * scheme adapter that owns it, enforces optional Work-authority gates, and lifts
 * adapter faults into boundary ContextErrors enriched with the canonical URI.
 */
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  AdapterFault,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
} from "../ports/context-adapter.js";
import type {
  ContextCreateTrackedDocumentResult,
  ContextEnsureTrackedDocumentResult,
  ContextError,
  ContextMoveOptions,
  ContextMoveResult,
  ContextPort,
  ContextReadResult,
  ContextScheme,
  ContextWriteBinaryOptions,
  ContextWriteOptions,
  ContextWriteResult,
  FileEntry,
  FileRef,
  SearchResult,
} from "../ports/context-port.js";
import { adapterFaultToContextError } from "./adapter-fault.js";
import { type ContextTreeDispatch, ContextTreeMover } from "./context-tree-mover.js";
import { type ParseContextUriOptions, parseContextUri, toCanonical } from "./uri.js";

export interface ContextPortRouterDeps {
  adapters: ReadonlyMap<ContextScheme, ContextSchemeAdapter>;
  /** Work IDs this port may address through `scheme://<workId>/...` authority URIs. */
  allowedAuthorities?: ReadonlySet<string>;
  /** Primary Work for bare Work-scoped URIs in this router. */
  primaryWorkId?: string;
  /** Lazily builds Work-scoped adapters for an authority-addressed target Work. */
  resolveWorkAdapters?: (workId: string) => ReadonlyMap<ContextScheme, ContextSchemeAdapter>;
  /** URI parse options — unified port passes manuscript default + extended schemes. */
  parseOptions?: ParseContextUriOptions;
}

interface Dispatch extends ContextTreeDispatch {
  adapter: ContextSchemeAdapter;
  scheme: ContextScheme;
  authority: string | null;
  workScopeId: string | null;
  path: string;
  canonical: string;
}

function uriFor(scheme: ContextScheme, path: string, authority: string | null): string {
  return toCanonical(scheme, path, authority);
}

function toSearchResult(
  scheme: ContextScheme,
  authority: string | null,
  hit: AdapterSearchHit,
): SearchResult {
  return {
    uri: uriFor(scheme, hit.path, authority),
    excerpt: hit.excerpt,
    line: hit.line,
    score: hit.score,
  };
}

function toFileRef(
  scheme: ContextScheme,
  authority: string | null,
  ref: AdapterFileRef,
  readonly: boolean,
): FileRef {
  const base = {
    uri: uriFor(scheme, ref.path, authority),
    documentId: ref.documentId,
    sizeBytes: ref.sizeBytes,
    updatedAt: ref.updatedAt,
    readonly,
  };
  if (ref.kind === "binary") {
    return {
      ...base,
      kind: "binary",
      fileType: ref.fileType,
      storageUrl: ref.storageUrl,
      mimeType: ref.mimeType,
    };
  }
  return {
    ...base,
    kind: "tracked",
    filetype: ref.filetype,
    schemaType: ref.schemaType,
  };
}

async function callAdapter<T>(
  uri: string,
  op: () => Promise<Result<T, AdapterFault>>,
): Promise<Result<T, ContextError>> {
  let result: Result<T, AdapterFault>;
  try {
    result = await op();
  } catch (error) {
    return Err({
      code: "io_error",
      uri,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!result.ok) return Err(adapterFaultToContextError(result.error, uri));
  return Ok(result.value);
}

export function createContextPortRouter(deps: ContextPortRouterDeps): ContextPort {
  const { adapters, parseOptions } = deps;
  const treeMover = new ContextTreeMover();

  function authorityAllowed(workId: string): boolean {
    return deps.allowedAuthorities?.has(workId) ?? false;
  }

  async function resolve(uri: string): Promise<Result<Dispatch, ContextError>> {
    const parsed = parseContextUri(uri, parseOptions);
    if (!parsed.ok) return parsed;
    const { scheme, authority, path, canonical } = parsed.value;

    let adapterMap = adapters;
    if (authority) {
      if (!authorityAllowed(authority)) return Err({ code: "permission_denied", uri: canonical });
      try {
        adapterMap = deps.resolveWorkAdapters?.(authority) ?? adapters;
      } catch (error) {
        return Err({
          code: "io_error",
          uri: canonical,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const adapter = adapterMap.get(scheme);
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
      authority,
      workScopeId: authority ?? deps.primaryWorkId ?? null,
      path,
      canonical,
    });
  }

  return {
    async stat(uri: string): Promise<Result<FileRef, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, scheme, authority, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.stat(path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok(toFileRef(scheme, authority, result.value, !adapter.capabilities.writable));
    },

    async read(uri: string): Promise<Result<ContextReadResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.read(path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok(result.value);
    },

    async write(
      uri: string,
      content: string,
      options?: ContextWriteOptions,
    ): Promise<Result<ContextWriteResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.write(path, content, options));
    },

    async ensureTrackedDocument(
      uri: string,
      options?: ContextWriteOptions,
    ): Promise<Result<ContextEnsureTrackedDocumentResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.ensureTrackedDocument(path, options));
    },

    async createTrackedDocument(
      uri: string,
      content: string,
      options?: ContextWriteOptions,
    ): Promise<Result<ContextCreateTrackedDocumentResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) return Err({ code: "permission_denied", uri: canonical });
      return callAdapter(canonical, () => adapter.createTrackedDocument(path, content, options));
    },

    async createUntitledDocument(homeUri, options) {
      const r = await resolve(homeUri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) return Err({ code: "permission_denied", uri: canonical });
      return callAdapter(canonical, () => adapter.createUntitledDocument(path, options));
    },

    async edit(
      uri: string,
      command: import("../ports/context-port.js").ContextEditCommand,
      options?: ContextWriteOptions,
    ): Promise<Result<ContextWriteResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.edit(path, command, options));
    },

    async writeBinary(
      uri: string,
      options: ContextWriteBinaryOptions,
    ): Promise<Result<ContextWriteResult, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.writeBinary(path, options));
    },

    async move(
      sourceUri: string,
      destinationUri: string,
      options?: ContextMoveOptions,
    ): Promise<Result<ContextMoveResult, ContextError>> {
      const source = await resolve(sourceUri);
      if (!source.ok) return source;
      const destination = await resolve(destinationUri);
      if (!destination.ok) return destination;
      if (source.value.canonical === destination.value.canonical) {
        return Err({ code: "invalid_operation", uri: destination.value.canonical });
      }
      if (
        source.value.scheme === destination.value.scheme &&
        source.value.workScopeId === destination.value.workScopeId
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
      return treeMover.move(source.value, destination.value, options);
    },

    async delete(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      if (!r.value.adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: r.value.canonical });
      }
      return treeMover.delete(r.value, options);
    },

    async mkdir(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>> {
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.mkdir(path, options));
    },

    async list(uri?: string): Promise<Result<FileEntry[], ContextError>> {
      if (!uri) {
        return Ok(
          [...adapters.keys()].sort().map((scheme) => ({
            kind: "directory" as const,
            uri: `${scheme}://`,
            readonly: !(adapters.get(scheme)?.capabilities.writable ?? false),
          })),
        );
      }
      const r = await resolve(uri);
      if (!r.ok) return r;
      const { adapter, scheme, authority, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.list(path));
      if (!result.ok) return result;

      const readonly = !adapter.capabilities.writable;
      return Ok(
        result.value.map((e) => {
          const base = {
            uri: uriFor(scheme, e.path, authority),
            documentId: e.documentId,
            sizeBytes: e.sizeBytes,
            updatedAt: e.updatedAt,
            readonly,
            provisionalName: e.provisionalName,
          };
          if (e.kind === "directory") return { ...base, kind: "directory" as const };
          if (e.editable) {
            return {
              ...base,
              kind: "file" as const,
              editable: true as const,
              filetype: e.filetype,
              schemaType: e.schemaType,
            };
          }
          return {
            ...base,
            kind: "file" as const,
            editable: false as const,
            fileType: e.fileType,
            mimeType: e.mimeType,
          };
        }),
      );
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
      for (const [scheme, adapter] of adapters) {
        if (!adapter.capabilities.searchable) continue;
        const result = await callAdapter(`${scheme}://`, () => adapter.search(query));
        if (!result.ok) continue;
        for (const hit of result.value) hits.push(toSearchResult(scheme, null, hit));
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return Ok(hits);
    },
  };
}
