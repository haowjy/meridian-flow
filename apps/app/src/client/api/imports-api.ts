/** HTTP client for the import routes. Refusals keep the server's code; the app writes the words. */
import type {
  ImportEntryStatus,
  ImportManifest,
  ImportRefusalCode,
  ImportStatus,
  ImportStatusChanges,
  ImportSummary,
} from "@meridian/contracts";
import { apiProjectPath } from "@meridian/contracts/protocol";
import { readResponsePayload } from "./http-client";

export class ImportRequestError extends Error {
  readonly name = "ImportRequestError";
  constructor(
    /** 0 when the request got no answer. */
    readonly status: number,
    readonly code: ImportRefusalCode | null,
    readonly params: Record<string, number> | undefined,
    message: string,
  ) {
    super(message);
  }
}

function importsPath(projectId: string, importId?: string): string {
  const base = `${apiProjectPath(projectId)}/imports`;
  return importId ? `${base}/${encodeURIComponent(importId)}` : base;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new ImportRequestError(0, null, undefined, "The request did not get an answer.");
  }
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    const data =
      typeof payload === "object" && payload !== null && "data" in payload
        ? (payload as { data?: { code?: ImportRefusalCode; params?: Record<string, number> } }).data
        : undefined;
    throw new ImportRequestError(
      response.status,
      data?.code ?? null,
      data?.params,
      `Import request failed: ${response.status}`,
    );
  }
  return payload as T;
}

export function planImport(projectId: string, manifest: ImportManifest, signal?: AbortSignal) {
  return request<ImportStatus>(importsPath(projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(manifest),
    signal,
  });
}

export function sendImportFiles(
  projectId: string,
  importId: string,
  parts: readonly { entryId: number; file: Blob; name: string }[],
  signal?: AbortSignal,
) {
  const form = new FormData();
  for (const part of parts) form.append(String(part.entryId), part.file, part.name);
  return request<{ entries: ImportEntryStatus[] }>(`${importsPath(projectId, importId)}/files`, {
    method: "POST",
    body: form,
    signal,
  });
}

export function finishImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportStatus>(`${importsPath(projectId, importId)}/finish`, {
    method: "POST",
    signal,
  });
}

export function resumeImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportStatus>(`${importsPath(projectId, importId)}/resume`, {
    method: "POST",
    signal,
  });
}

export function dismissImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportStatus>(`${importsPath(projectId, importId)}/dismiss`, {
    method: "POST",
    signal,
  });
}

export function getImportStatus(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportStatus>(importsPath(projectId, importId), { method: "GET", signal });
}

export function getImportChanges(
  projectId: string,
  importId: string,
  since: string,
  signal?: AbortSignal,
) {
  return request<ImportStatusChanges>(
    `${importsPath(projectId, importId)}?since=${encodeURIComponent(since)}`,
    { method: "GET", signal },
  );
}

export function listOpenImports(projectId: string, signal?: AbortSignal) {
  return request<ImportSummary[]>(`${importsPath(projectId)}?open=1`, { method: "GET", signal });
}
