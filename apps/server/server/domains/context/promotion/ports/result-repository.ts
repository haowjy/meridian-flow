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
  id: string;
  projectId: string;
  sourcePath: string;
  resultsUri: string;
  storageUrl: string;
  mimeType: string;
  sizeBytes: number;
  provenance: ResultProvenance;
}

export interface ResultRepository {
  createOrConverge(input: CreateProjectResultInput): Promise<CreateProjectResultOutcome>;
  listByProject(projectId: string): Promise<ProjectResultRecord[]>;
}

export type CreateProjectResultOutcome =
  | { kind: "committed"; record: ProjectResultRecord }
  | { kind: "definitely_not_committed"; error: string }
  | { kind: "unknown"; error: string };
