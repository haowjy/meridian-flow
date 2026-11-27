export type ExportDocument = {
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
  sizeBytes: number | null;
  metadata: unknown;
};
export type ExportSourceRoot = Pick<
  ExportDocument,
  "scheme" | "workId" | "workName" | "rootThreadId" | "chatTitle"
> & { uri: string };
export type ExportFolder = ExportSourceRoot & { path: string };
export interface ExportSnapshotStore {
  read(projectId: string): Promise<{
    documents: ExportDocument[];
    folders: ExportFolder[];
    sources: ExportSourceRoot[];
    settlements: ReadonlyMap<string, string>;
  }>;
}
