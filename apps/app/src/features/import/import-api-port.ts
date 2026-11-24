import {
  acknowledgeImport,
  createImport,
  getImportDetail,
  listOpenImports,
  markPickedImportFiles,
  retryImport,
  sendImportFiles,
  skipImportFiles,
  stopImport,
} from "@/client/api/imports-api";
export const importApi = {
  create: createImport,
  send: sendImportFiles,
  skip: skipImportFiles,
  picked: markPickedImportFiles,
  stop: stopImport,
  retry: retryImport,
  acknowledge: acknowledgeImport,
  detail: getImportDetail,
  listOpen: listOpenImports,
};
export type ImportApi = typeof importApi;
