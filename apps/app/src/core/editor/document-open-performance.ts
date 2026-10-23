/** Stable browser marks for profiling one document-open pipeline. */
export function markDocumentOpen(
  stage: string,
  detail: { documentId: string; attemptId?: string; [key: string]: unknown },
): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark(`doc-open:${stage}`, { detail });
}
