/**
 * KB corpus import handlers folded into the unified Context surface.
 * Converter + ingest logic stays in the context domain; routes call these
 * handlers instead of a separate corpus-import app service seam.
 */
import {
  type CorpusImportBatchResult,
  type CorpusImportInputFile,
  type CorpusImportSource,
  createCorpusImportService,
  createFixtureDriveImportSource,
  createMammothDocumentConverter,
  type UnifiedContextPortFactory,
} from "../domains/context/index.js";

export type ContextImportRouteDeps = {
  contextPorts: UnifiedContextPortFactory;
};

function importService(deps: ContextImportRouteDeps) {
  return createCorpusImportService({
    contextPorts: deps.contextPorts,
    converter: createMammothDocumentConverter(),
    driveSource: createFixtureDriveImportSource(),
  });
}

export async function handleContextKbImportFilesRequest(
  deps: ContextImportRouteDeps,
  input: {
    userId: string;
    projectId: string;
    files: CorpusImportInputFile[];
    source: CorpusImportSource;
  },
): Promise<CorpusImportBatchResult> {
  return importService(deps).importFiles(input);
}

export async function handleContextKbImportDriveFixtureRequest(
  deps: ContextImportRouteDeps,
  input: { userId: string; projectId: string },
): Promise<CorpusImportBatchResult> {
  return importService(deps).importDriveFixture(input);
}
