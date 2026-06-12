/**
 * Context-port router: builds a ContextPort that parses a URI, dispatches to the
 * scheme adapter that owns it, and lifts adapter faults into boundary
 * ContextErrors enriched with the canonical URI. Owns scheme->adapter dispatch
 * only; it holds no workbench/thread scope (adapters carry their own).
 */
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  AdapterFault,
  AdapterFileRef,
  AdapterSearchHit,
  ContextSchemeAdapter,
} from "../ports/context-adapter.js";
import type {
  ContextError,
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
import { parseContextUri } from "./uri.js";

export interface ContextPortRouterDeps {
  adapters: ReadonlyMap<ContextScheme, ContextSchemeAdapter>;
}

/** A parsed URI paired with the adapter that owns its scheme. */
interface Dispatch {
  adapter: ContextSchemeAdapter;
  scheme: ContextScheme;
  path: string;
  canonical: string;
}

/** Attach the canonical URI to an adapter fault, producing a {@link ContextError}. */
function toContextError(fault: AdapterFault, uri: string): ContextError {
  switch (fault.code) {
    case "permission_denied":
      return { code: "permission_denied", uri };
    case "context_unavailable":
      return { code: "context_unavailable", uri };
    case "io_error":
      return { code: "io_error", uri, message: fault.message };
  }
}

function toSearchResult(scheme: ContextScheme, hit: AdapterSearchHit): SearchResult {
  return { uri: `${scheme}://${hit.path}`, excerpt: hit.excerpt, line: hit.line, score: hit.score };
}

function toFileRef(scheme: ContextScheme, ref: AdapterFileRef, readonly: boolean): FileRef {
  const base = {
    uri: `${scheme}://${ref.path}`,
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

/**
 * Build a {@link ContextPort} that dispatches by URI scheme to the registered
 * adapters. The router is a pure dispatch layer — it holds no workbench/thread
 * scope; adapters carry their own scope.
 */
export function createContextPortRouter(deps: ContextPortRouterDeps): ContextPort {
  const { adapters } = deps;

  /** Parse a URI and look up its adapter, or return the boundary error. */
  function resolve(uri: string): Result<Dispatch, ContextError> {
    const parsed = parseContextUri(uri);
    if (!parsed.ok) return parsed;
    const { scheme, path, canonical } = parsed.value;
    const adapter = adapters.get(scheme);
    if (!adapter) {
      return Err({
        code: "invalid_uri",
        uri: canonical,
        reason: `No adapter registered for scheme "${scheme}"`,
      });
    }
    return Ok({ adapter, scheme, path, canonical });
  }

  /**
   * Invoke an adapter operation, upholding the ContextPort contract that no
   * errors are thrown across the boundary: adapter `AdapterFault`s and any
   * unexpected promise rejection (DB error, constraint violation) both become
   * a {@link ContextError}.
   */
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
    if (!result.ok) return Err(toContextError(result.error, uri));
    return Ok(result.value);
  }

  return {
    async stat(uri: string): Promise<Result<FileRef, ContextError>> {
      const r = resolve(uri);
      if (!r.ok) return r;
      const { adapter, scheme, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.stat(path));
      if (!result.ok) return result;
      if (result.value === null) return Err({ code: "not_found", uri: canonical });
      return Ok(toFileRef(scheme, result.value, !adapter.capabilities.writable));
    },

    async read(uri: string): Promise<Result<ContextReadResult, ContextError>> {
      const r = resolve(uri);
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
      const r = resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.write(path, content, options));
    },

    async writeBinary(
      uri: string,
      options: ContextWriteBinaryOptions,
    ): Promise<Result<ContextWriteResult, ContextError>> {
      const r = resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.writeBinary(path, options));
    },

    async mkdir(uri: string, options?: ContextWriteOptions): Promise<Result<void, ContextError>> {
      const r = resolve(uri);
      if (!r.ok) return r;
      const { adapter, path, canonical } = r.value;
      if (!adapter.capabilities.writable) {
        return Err({ code: "permission_denied", uri: canonical });
      }
      return callAdapter(canonical, () => adapter.mkdir(path, options));
    },

    async list(uri: string): Promise<Result<FileEntry[], ContextError>> {
      const r = resolve(uri);
      if (!r.ok) return r;
      const { adapter, scheme, path, canonical } = r.value;

      const result = await callAdapter(canonical, () => adapter.list(path));
      if (!result.ok) return result;

      const readonly = !adapter.capabilities.writable;
      return Ok(
        result.value.map((e) => {
          const base = {
            uri: `${scheme}://${e.path}`,
            documentId: e.documentId,
            sizeBytes: e.sizeBytes,
            updatedAt: e.updatedAt,
            readonly,
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
        const r = resolve(uri);
        if (!r.ok) return r;
        const { adapter, scheme, path, canonical } = r.value;
        if (!adapter.capabilities.searchable) return Ok([]);

        const result = await callAdapter(canonical, () => adapter.search(query, path));
        if (!result.ok) return result;
        return Ok(result.value.map((hit) => toSearchResult(scheme, hit)));
      }

      // Cross-scheme search: fan out to searchable adapters. Best-effort — a single backend failing (Err or throw)
      // must not fail the whole search, so failures are skipped, not raised.
      const hits: SearchResult[] = [];
      for (const [scheme, adapter] of adapters) {
        if (!adapter.capabilities.searchable) continue;
        const result = await callAdapter(`${scheme}://`, () => adapter.search(query));
        if (!result.ok) continue;
        for (const hit of result.value) hits.push(toSearchResult(scheme, hit));
      }
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      return Ok(hits);
    },
  };
}
