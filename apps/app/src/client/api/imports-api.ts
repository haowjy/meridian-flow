/** HTTP client for the import routes. Refusals keep the server's code; the app writes the words. */
import type {
  ImportDetail,
  ImportFilesResult,
  ImportRefusalCode,
  ImportSelection,
  ImportSkipsInput,
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

function requestError(status: number, payload: unknown) {
  const data =
    typeof payload === "object" && payload !== null && "data" in payload
      ? (payload as { data?: { code?: ImportRefusalCode; params?: Record<string, number> } }).data
      : undefined;
  return new ImportRequestError(
    status,
    data?.code ?? null,
    data?.params,
    `Import request failed: ${status}`,
  );
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
  if (!response.ok) throw requestError(response.status, payload);
  return payload as T;
}

export function createImport(projectId: string, selection: ImportSelection, signal?: AbortSignal) {
  return request<ImportSummary>(importsPath(projectId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
    signal,
  });
}
/** XHR exposes upload bytes; Fetch does not. Errors share the ordinary command contract. */
export function sendImportFiles(
  projectId: string,
  importId: string,
  parts: readonly { entryId: number; file: Blob; name: string; changed?: boolean }[],
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void,
): Promise<ImportFilesResult> {
  const form = new FormData();
  for (const part of parts) form.append(String(part.entryId), part.file, part.name);
  const bytes = parts.reduce((sum, part) => sum + part.file.size, 0);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${importsPath(projectId, importId)}/files`);
    xhr.responseType = "json";
    xhr.timeout = 600000;
    xhr.setRequestHeader(
      "X-Import-Changed-Entries",
      parts
        .filter((part) => part.changed)
        .map((part) => part.entryId)
        .join(","),
    );
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.((bytes * event.loaded) / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(xhr.response as ImportFilesResult)
        : reject(requestError(xhr.status, xhr.response));
    xhr.onerror = xhr.ontimeout = () => reject(requestError(0, null));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    xhr.onloadend = () => signal?.removeEventListener("abort", abort);
    xhr.send(form);
  });
}
export function skipImportFiles(
  projectId: string,
  importId: string,
  input: ImportSkipsInput,
  signal?: AbortSignal,
) {
  return request<ImportSummary>(`${importsPath(projectId, importId)}/skips`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}
export function stopImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportSummary>(`${importsPath(projectId, importId)}/stop`, {
    method: "POST",
    signal,
  });
}
export function retryImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportSummary>(`${importsPath(projectId, importId)}/retry`, {
    method: "POST",
    signal,
  });
}
export function acknowledgeImport(projectId: string, importId: string, signal?: AbortSignal) {
  return request<void>(`${importsPath(projectId, importId)}/acknowledge`, {
    method: "POST",
    signal,
  });
}
export function getImportDetail(projectId: string, importId: string, signal?: AbortSignal) {
  return request<ImportDetail>(importsPath(projectId, importId), { method: "GET", signal });
}
export function listOpenImports(signal?: AbortSignal) {
  return request<ImportSummary[]>("/api/imports?open=1", { method: "GET", signal });
}
