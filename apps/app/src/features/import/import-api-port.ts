/** The network calls the coordinator makes, as one seam so tests can stand in for the server. */
import {
  dismissImport,
  finishImport,
  getImportChanges,
  getImportReport,
  listOpenImports,
  planImport,
  sendImportFiles,
} from "@/client/api/imports-api";

export type ImportApi = {
  plan: typeof planImport;
  send: typeof sendImportFiles;
  finish: typeof finishImport;
  dismiss: typeof dismissImport;
  report: typeof getImportReport;
  changes: typeof getImportChanges;
  listOpen: typeof listOpenImports;
};

export const importApi: ImportApi = {
  plan: planImport,
  send: sendImportFiles,
  finish: finishImport,
  dismiss: dismissImport,
  report: getImportReport,
  changes: getImportChanges,
  listOpen: listOpenImports,
};
