export interface ImportDestination {
  destination(uri: string): Promise<{ folderId: string | null }>;
}
