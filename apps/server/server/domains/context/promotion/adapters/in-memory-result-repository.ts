import { randomUUID } from "node:crypto";
import type {
  CreateProjectResultInput,
  ProjectResultRecord,
  ResultRepository,
} from "../ports/result-repository.js";

export class InMemoryResultRepository implements ResultRepository {
  private readonly records: ProjectResultRecord[] = [];
  async create(input: CreateProjectResultInput): Promise<ProjectResultRecord> {
    const record: ProjectResultRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      resultsUri: input.resultsUri,
      storageUrl: input.storageUrl,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      provenance: { ...input.provenance },
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
    return { ...record, provenance: { ...record.provenance } };
  }
  async listByProject(projectId: string): Promise<ProjectResultRecord[]> {
    return this.records
      .filter((row) => row.projectId === projectId)
      .map((row) => ({ ...row, provenance: { ...row.provenance } }));
  }
}
export function createInMemoryResultRepository(): ResultRepository {
  return new InMemoryResultRepository();
}
