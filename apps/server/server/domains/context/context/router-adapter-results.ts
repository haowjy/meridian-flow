/** Translation from scheme-adapter results into canonical ContextPort results. */
import type { CanonicalContextAuthority } from "@meridian/contracts/context-uri";
import { Err, Ok, type Result } from "../../../shared/result.js";
import type {
  AdapterFault,
  AdapterFileEntry,
  AdapterFileRef,
  AdapterSearchHit,
} from "../ports/context-adapter.js";
import { ContextEntryConflictError } from "../ports/context-document-store.js";
import type {
  ContextError,
  ContextScheme,
  FileEntry,
  FileRef,
  SearchResult,
} from "../ports/context-port.js";
import { adapterFaultToContextError } from "./adapter-fault.js";
import { toCanonical } from "./uri.js";

export function toSearchResult(
  scheme: ContextScheme,
  authority: CanonicalContextAuthority,
  hit: AdapterSearchHit,
): SearchResult {
  return {
    uri: toCanonical(scheme, hit.path, authority),
    documentId: hit.documentId,
    revision: hit.revision,
    matches: hit.matches,
    matchCount: hit.matchCount,
    score: hit.score,
    ...(hit.shown ? { shown: hit.shown } : {}),
  };
}

export function toFileRef(
  scheme: ContextScheme,
  authority: CanonicalContextAuthority,
  ref: AdapterFileRef,
  readonly: boolean,
): FileRef {
  const base = {
    uri: toCanonical(scheme, ref.path, authority),
    documentId: ref.documentId,
    sizeBytes: ref.sizeBytes,
    updatedAt: ref.updatedAt,
    readonly,
    ...(ref.properties ? { properties: ref.properties } : {}),
    ...(ref.aliases ? { aliases: ref.aliases } : {}),
  };
  return ref.kind === "binary"
    ? {
        ...base,
        kind: "binary",
        fileType: ref.fileType,
        storageUrl: ref.storageUrl,
        mimeType: ref.mimeType,
        hasPreview: ref.hasPreview,
      }
    : { ...base, kind: "tracked", filetype: ref.filetype, schemaType: ref.schemaType };
}

export function toFileEntry(
  scheme: ContextScheme,
  authority: CanonicalContextAuthority,
  entry: AdapterFileEntry,
  readonly: boolean,
): FileEntry {
  const { path, ...metadata } = entry;
  return { ...metadata, uri: toCanonical(scheme, path, authority), readonly };
}

export async function callAdapter<T>(
  uri: string,
  op: () => Promise<Result<T, AdapterFault>>,
): Promise<Result<T, ContextError>> {
  let result: Result<T, AdapterFault>;
  try {
    result = await op();
  } catch (error) {
    if (error instanceof ContextEntryConflictError)
      return Err({ code: "conflict", uri, occupantKind: error.occupantKind });
    return Err({
      code: "io_error",
      uri,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (!result.ok) return Err(adapterFaultToContextError(result.error, uri));
  return Ok(result.value);
}
