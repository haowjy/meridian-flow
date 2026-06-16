import type { ResultProvenance } from "../result-provenance.js";

export interface ProjectResultRecord {
  id: string;
  projectId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
  createdAt: string;
}

export interface CreateProjectResultInput {
  projectId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
}

export interface ResultRepository {
  create(input: CreateProjectResultInput): Promise<ProjectResultRecord>;
  listByProject(projectId: string): Promise<ProjectResultRecord[]>;
}
