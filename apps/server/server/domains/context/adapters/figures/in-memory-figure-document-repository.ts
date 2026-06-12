import type {
  AttachDocumentFileInput,
  DocumentFileRecord,
  FigureDocumentRepository,
} from "../../ports/figure-document-repository.js";

export interface InMemoryFigureDocumentRepositoryOptions {
  records?: AttachDocumentFileInput[];
}
const keyFor = (workbenchId: string, documentId: string) => `${workbenchId}\0${documentId}`;
const toRecord = (input: AttachDocumentFileInput): DocumentFileRecord => ({
  documentId: input.documentId,
  storageUrl: input.storageUrl,
  mimeType: input.mimeType,
  fileType: input.fileType,
  sizeBytes: input.sizeBytes,
});

export class InMemoryFigureDocumentRepository implements FigureDocumentRepository {
  private readonly records = new Map<string, DocumentFileRecord>();
  constructor(options: InMemoryFigureDocumentRepositoryOptions = {}) {
    for (const record of options.records ?? [])
      this.records.set(keyFor(record.workbenchId, record.documentId), toRecord(record));
  }
  async findDocumentFileForWorkbench(
    workbenchId: string,
    documentId: string,
  ): Promise<DocumentFileRecord | null> {
    const record = this.records.get(keyFor(workbenchId, documentId));
    return record ? { ...record } : null;
  }
  async attachDocumentFile(input: AttachDocumentFileInput): Promise<DocumentFileRecord> {
    const record = toRecord(input);
    this.records.set(keyFor(input.workbenchId, input.documentId), record);
    return { ...record };
  }
}

export function createInMemoryFigureDocumentRepository(
  options?: InMemoryFigureDocumentRepositoryOptions,
): FigureDocumentRepository {
  return new InMemoryFigureDocumentRepository(options);
}
