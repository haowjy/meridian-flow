import type {
  DocumentFileRecord,
  FigureDocumentRepository,
  ProjectDocumentFileRecord,
} from "../../ports/figure-document-repository.js";

export interface InMemoryFigureDocumentRepositoryOptions {
  records?: ProjectDocumentFileRecord[];
  documentIds?: Array<{ projectId: string; documentId: string }>;
}
const keyFor = (projectId: string, documentId: string) => `${projectId}\0${documentId}`;
const toRecord = (input: ProjectDocumentFileRecord): DocumentFileRecord => ({
  assetDocumentId: input.assetDocumentId,
  storageUrl: input.storageUrl,
  mimeType: input.mimeType,
  fileType: input.fileType,
  sizeBytes: input.sizeBytes,
});

export class InMemoryFigureDocumentRepository implements FigureDocumentRepository {
  private readonly records = new Map<string, DocumentFileRecord>();
  private readonly documentKeys = new Set<string>();
  constructor(options: InMemoryFigureDocumentRepositoryOptions = {}) {
    for (const record of options.records ?? []) {
      this.records.set(keyFor(record.projectId, record.assetDocumentId), toRecord(record));
      this.documentKeys.add(keyFor(record.projectId, record.assetDocumentId));
    }
    for (const document of options.documentIds ?? [])
      this.documentKeys.add(keyFor(document.projectId, document.documentId));
  }
  async documentExistsForProject(projectId: string, documentId: string): Promise<boolean> {
    return this.documentKeys.has(keyFor(projectId, documentId));
  }
  async findDocumentFileForProject(
    projectId: string,
    assetDocumentId: string,
  ): Promise<DocumentFileRecord | null> {
    const record = this.records.get(keyFor(projectId, assetDocumentId));
    return record ? { ...record } : null;
  }
}

export function createInMemoryFigureDocumentRepository(
  options?: InMemoryFigureDocumentRepositoryOptions,
): FigureDocumentRepository {
  return new InMemoryFigureDocumentRepository(options);
}
