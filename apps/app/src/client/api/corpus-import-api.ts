import { type CorpusImportResponse, deserializeTransport } from "@meridian/contracts/protocol";

import { errorMessageFromPayload, postJson } from "./http-client";

export type UploadCorpusFilesInput = {
  projectId: string;
  files: File[];
  onProgress?: (progress: { loaded: number; total: number | null; percent: number | null }) => void;
};

function importPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/corpus-import`;
}

function parseXhrPayload(xhr: XMLHttpRequest): unknown {
  if (!xhr.responseText) return null;
  try {
    return JSON.parse(xhr.responseText) as unknown;
  } catch {
    return xhr.responseText;
  }
}

function appendFile(form: FormData, file: File): void {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  form.append("files", file, path || file.name);
}

export function uploadCorpusFiles(input: UploadCorpusFilesInput): Promise<CorpusImportResponse> {
  const form = new FormData();
  for (const file of input.files) appendFile(form, file);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${importPath(input.projectId)}/files`);
    xhr.upload.onprogress = (event) => {
      const total = event.lengthComputable ? event.total : null;
      input.onProgress?.({
        loaded: event.loaded,
        total,
        percent: total && total > 0 ? Math.round((event.loaded / total) * 100) : null,
      });
    };
    xhr.onerror = () =>
      reject(new Error("Corpus import failed. Check your connection and try again."));
    xhr.onabort = () => reject(new Error("Corpus import was cancelled."));
    xhr.onload = () => {
      const payload = parseXhrPayload(xhr);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(errorMessageFromPayload(payload, xhr.status)));
        return;
      }
      resolve(deserializeTransport<CorpusImportResponse>(payload as CorpusImportResponse));
    };
    xhr.send(form);
  });
}

export async function importDriveFixture(projectId: string): Promise<CorpusImportResponse> {
  return postJson<CorpusImportResponse>(`${importPath(projectId)}/drive-fixture`, {});
}
