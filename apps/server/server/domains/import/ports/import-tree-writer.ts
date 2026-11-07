/** Upload admission resolves a destination without allocating names or creating documents. */
export interface ImportDestination {
  destination(uri: string): Promise<{ folderId: string | null }>;
}
