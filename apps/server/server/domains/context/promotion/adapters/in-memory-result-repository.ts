import { randomUUID } from "node:crypto";
import type {
  CreateWorkbenchResultInput,
  ResultRepository,
  WorkbenchResultRecord,
} from "../ports/result-repository.js";

export class InMemoryResultRepository implements ResultRepository {
  private readonly records: WorkbenchResultRecord[] = [];
  async create(input: CreateWorkbenchResultInput): Promise<WorkbenchResultRecord> {
    const record: WorkbenchResultRecord = {
      id: randomUUID(),
      workbenchId: input.workbenchId,
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
  async listByWorkbench(workbenchId: string): Promise<WorkbenchResultRecord[]> {
    return this.records
      .filter((row) => row.workbenchId === workbenchId)
      .map((row) => ({ ...row, provenance: { ...row.provenance } }));
  }
}
export function createInMemoryResultRepository(): ResultRepository {
  return new InMemoryResultRepository();
}
