export type DriveImportFile = {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  relativePath?: string;
};

export interface DriveImportSourcePort {
  listFiles(input: { userId: string; projectId: string }): Promise<DriveImportFile[]>;
}
