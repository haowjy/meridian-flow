/** The network calls the coordinator makes, as one seam so tests can stand in for the server. */
import {
  dismissImport,
  finishImport,
  getImportChanges,
  getImportStatus,
  listOpenImports,
  planImport,
  resumeImport,
  sendImportFiles,
} from "@/client/api/imports-api";

export type ImportApi = {
  plan: typeof planImport;
  send: typeof sendImportFiles;
  finish: typeof finishImport;
  resume: typeof resumeImport;
  dismiss: typeof dismissImport;
  status: typeof getImportStatus;
  changes: typeof getImportChanges;
  listOpen: typeof listOpenImports;
};

export const importApi: ImportApi = {
  plan: planImport,
  send: sendImportFiles,
  finish: finishImport,
  resume: resumeImport,
  dismiss: dismissImport,
  status: getImportStatus,
  changes: getImportChanges,
  listOpen: listOpenImports,
};
