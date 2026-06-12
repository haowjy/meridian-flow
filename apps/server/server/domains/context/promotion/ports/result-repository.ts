import type { ResultProvenance } from "../result-provenance.js";

export interface WorkbenchResultRecord {
  id: string;
  workbenchId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
  createdAt: string;
}

export interface CreateWorkbenchResultInput {
  workbenchId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
}

export interface ResultRepository {
  create(input: CreateWorkbenchResultInput): Promise<WorkbenchResultRecord>;
  listByWorkbench(workbenchId: string): Promise<WorkbenchResultRecord[]>;
}
