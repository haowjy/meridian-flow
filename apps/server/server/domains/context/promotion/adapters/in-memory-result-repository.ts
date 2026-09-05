import type {
  CreateProjectResultInput,
  ProjectResultRecord,
  ResultRepository,
} from "../ports/result-repository.js";

export class InMemoryResultRepository implements ResultRepository {
  private readonly records: ProjectResultRecord[] = [];
  async createOrConverge(input: CreateProjectResultInput) {
    const existing = this.records.find((row) => row.id === input.id);
    if (existing) {
      return JSON.stringify({ ...existing, createdAt: undefined }) ===
        JSON.stringify({ ...input, createdAt: undefined })
        ? {
            kind: "committed" as const,
            record: { ...existing, provenance: { ...existing.provenance } },
          }
        : { kind: "unknown" as const, error: "Result ID already has different payload" };
    }
    const record: ProjectResultRecord = {
      id: input.id,
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
    return {
      kind: "committed" as const,
      record: { ...record, provenance: { ...record.provenance } },
    };
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
