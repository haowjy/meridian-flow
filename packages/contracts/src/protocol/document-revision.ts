/** Host-only evidence about text carried by a document read or write. */
export type DocumentRevisionEvidence = {
  documentId: string;
  /** Canonical URI at observation time; null for identity-only sources such as folded diffs. */
  uri: string | null;
  /** Opaque equality token. Null means the source state cannot be proven. */
  revision: string | null;
};
