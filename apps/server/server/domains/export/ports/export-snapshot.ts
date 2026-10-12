/** Project export inventory, captured atomically before any content is streamed. */
export type ExportDocument = {
  manifestScoped: boolean;
  id: string;
  uri: string;
  path: string;
  scheme: string;
  workId: string | null;
  workName: string | null;
  rootThreadId: string | null;
  chatTitle: string | null;
  name: string;
  extension: string;
  fileType: string;
  storageUrl: string | null;
  metadata: unknown;
};
export type ExportSourceRoot = Pick<
  ExportDocument,
  "scheme" | "workId" | "workName" | "rootThreadId" | "chatTitle"
> & { uri: string };
export interface ExportSnapshotStore {
  read(projectId: string): Promise<{
    documents: ExportDocument[];
    sources: ExportSourceRoot[];
    settlements: ReadonlyMap<string, string>;
  }>;
}
